import { safeQuoteText } from "../quotes/reply-projection.js";
import { createHmac } from "node:crypto";
import type pg from "pg";
import type {
  GroupHistory,
  HistoryConfig,
  HistoryScope,
  HistoryDependency,
  HistoryQuery,
  HistoryResult
} from "./types.js";

export class PostgresGroupHistory implements GroupHistory {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: HistoryConfig,
    private readonly key: string,
    private readonly authorize: (scope: HistoryScope) => Promise<boolean> = async () => false
  ) {}
  private hash(value: string) {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
  private policy(scope: HistoryScope, lifecycle = false) {
    if (
      !this.config.enabled ||
      scope.source.type !== "group" ||
      !scope.source.groupId ||
      (!scope.source.userId && !lifecycle)
    )
      return undefined;
    return this.config.policies.find(
      (p) => p.profileName === scope.profileName && p.groupId === scope.source.groupId
    );
  }
  enabledFor(scope: HistoryScope) {
    return Boolean(this.policy(scope));
  }
  async synchronize() {
    if (
      !this.config.enabled &&
      !(await this.pool.query("select to_regclass('group_history_policy') as name")).rows[0].name
    )
      return;
    await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(6401030)");
      const control = (
        await client.query(
          "select generation,config_key from group_history_control where singleton for update"
        )
      ).rows[0];
      const configKey = this.hash(JSON.stringify(this.config));
      if (control && Number(control.generation) > this.config.generation) return;
      if (
        control &&
        Number(control.generation) === this.config.generation &&
        control.config_key !== configKey
      )
        throw new Error("history_config_generation_conflict");
      await client.query(
        "insert into group_history_control values(true,$1,$2) on conflict(singleton) do update set generation=excluded.generation,config_key=excluded.config_key",
        [this.config.generation, configKey]
      );
      await client.query("update group_history_policy set enabled=false");
      if (this.config.enabled)
        for (const p of this.config.policies) {
          const scope = this.scope({
            profileName: p.profileName,
            source: { type: "group", groupId: p.groupId }
          });
          await client.query(
            `insert into group_history_policy(scope,revision,restore_epoch,enabled_at,enabled) values($1,$2,$3,$4,true) on conflict(scope) do update set revision=excluded.revision,restore_epoch=excluded.restore_epoch,enabled_at=excluded.enabled_at,enabled=true`,
            [scope, this.revision(p), this.config.restoreEpoch, p.enabledAt]
          );
        }
    });
  }
  private revision(policy: HistoryConfig["policies"][number]) {
    return this.hash(JSON.stringify([policy, this.config.retentionDays]));
  }
  private scope(scope: HistoryScope) {
    return this.hash(JSON.stringify([scope.profileName, scope.source.groupId]));
  }
  private async current(client: pg.PoolClient): Promise<boolean> {
    return Boolean(
      (
        await client.query(
          "select 1 from group_history_control where singleton and generation=$1 and config_key=$2",
          [this.config.generation, this.hash(JSON.stringify(this.config))]
        )
      ).rowCount
    );
  }
  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '250ms'");
      await client.query("set local lock_timeout = '50ms'");
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async ingest(
    scope: HistoryScope,
    event: Parameters<GroupHistory["ingest"]>[1],
    anchor?: HistoryDependency[]
  ) {
    const policy = this.policy(scope, event.type === "unsend");
    if (
      !policy ||
      policy.excludedRequesterIds.includes(scope.source.userId!) ||
      !(await this.authorize(scope).catch(() => false))
    )
      return;
    const id = event.type === "unsend" ? event.unsend?.messageId : event.message?.id;
    const withdrawn = event.type === "unsend";
    if (
      !id ||
      id.length > 255 ||
      (!withdrawn &&
        (event.message?.type !== "text" ||
          !event.message.text ||
          event.message.text.startsWith("/")))
    )
      return;
    const now = Date.now();
    const at = event.timestamp;
    if (
      !at ||
      at > now + 60_000 ||
      at < Date.parse(policy.enabledAt) ||
      at < now - this.config.retentionDays * 86400000
    )
      return;
    const body = withdrawn ? null : event.message!.text!;
    const bytes = Buffer.byteLength(body ?? "");
    const scopeKey = this.scope(scope);
    await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(6401030)");
      if (!(await this.current(client))) return;
      const current = (
        await client.query(
          "select floor_at from group_history_policy where scope=$1 and enabled and revision=$2 and restore_epoch=$3",
          [scopeKey, this.revision(policy), this.config.restoreEpoch]
        )
      ).rows[0];
      if (!current || new Date(at) < current.floor_at) return;
      if (bytes > this.config.maxMessageBytes) {
        await client.query("update group_history_policy set gap=true where scope=$1", [scopeKey]);
        return;
      }
      await client.query(
        `insert into group_history_message(scope,message_key,requester_key,revision,restore_epoch,occurred_at,expires_at,quoted_key,body,withdrawn,human,dependencies)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(scope,message_key) do update set
        body=case when excluded.withdrawn then null else group_history_message.body end,
        withdrawn=group_history_message.withdrawn or excluded.withdrawn`,
        [
          scopeKey,
          this.hash(scopeKey + id),
          this.hash(scopeKey + (scope.source.userId ?? "withdrawn")),
          this.revision(policy),
          this.config.restoreEpoch,
          new Date(at),
          new Date(at + this.config.retentionDays * 86400000),
          event.message?.quotedMessageId
            ? this.hash(scopeKey + event.message.quotedMessageId)
            : null,
          body,
          withdrawn,
          anchor === undefined,
          anchor === undefined ? null : JSON.stringify(anchor)
        ]
      );
      // Eviction advances a permanent time floor so late events cannot resurrect removed data.
      const readStats = async () =>
        (
          await client.query(
            `select count(*)::int as total,coalesce(sum(octet_length(body)),0)::bigint as bytes,
        count(*) filter(where scope=$1)::int as group_total,coalesce(sum(octet_length(body)) filter(where scope=$1),0)::bigint as group_bytes from group_history_message`,
            [scopeKey]
          )
        ).rows[0];
      const stats = await readStats();
      if (
        stats.total > this.config.maxTotalMessages ||
        Number(stats.bytes) > this.config.maxTotalBytes ||
        stats.group_total > this.config.maxGroupMessages ||
        Number(stats.group_bytes) > this.config.maxGroupBytes
      ) {
        const groupOver =
          stats.group_total > this.config.maxGroupMessages ||
          Number(stats.group_bytes) > this.config.maxGroupBytes;
        const removed = await client.query(
          `delete from group_history_message where (scope,message_key) in
          (select scope,message_key from group_history_message where ($1::text is null or scope=$1) order by occurred_at,message_key limit 100)
          returning scope,occurred_at`,
          [groupOver ? scopeKey : null]
        );
        for (const scope of new Set<string>(removed.rows.map((r) => r.scope))) {
          const floor = new Date(
            Math.max(
              ...removed.rows.filter((r) => r.scope === scope).map((r) => r.occurred_at.getTime())
            ) + 1
          );
          await client.query(
            "update group_history_policy set floor_at=greatest(floor_at,$2),gap=true where scope=$1",
            [scope, floor]
          );
        }
        const after = await readStats();
        if (
          after.total > this.config.maxTotalMessages ||
          Number(after.bytes) > this.config.maxTotalBytes ||
          after.group_total > this.config.maxGroupMessages ||
          Number(after.group_bytes) > this.config.maxGroupBytes
        )
          throw new Error("history_capacity_exceeded");
      }
    });
  }
  async search(scope: HistoryScope, query: HistoryQuery, now: Date): Promise<HistoryResult> {
    const fallback: HistoryResult = {
      status: "unavailable",
      start: query.start,
      end: query.end,
      incomplete: true,
      records: []
    };
    const policy = this.policy(scope);
    if (!policy || !(await this.authorize(scope).catch(() => false))) return fallback;
    const start = Date.parse(query.start),
      end = Date.parse(query.end);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end > now.getTime() + 60000 ||
      start <
        Math.max(Date.parse(policy.enabledAt), now.getTime() - this.config.retentionDays * 86400000)
    )
      return fallback;
    if (end - start > 1800000 && !query.topic?.trim() && !query.quotedMessageId) return fallback;
    const key = this.scope(scope);
    return this.transaction(async (client) => {
      if (!(await this.current(client))) return fallback;
      const p = (
        await client.query(
          "select * from group_history_policy where scope=$1 and enabled and revision=$2 and restore_epoch=$3",
          [key, this.revision(policy), this.config.restoreEpoch]
        )
      ).rows[0];
      if (!p) return fallback;
      const rows = (
        await client.query(
          `select message_key,requester_key,occurred_at,body,quoted_key from group_history_message
        where scope=$1 and revision=$2 and restore_epoch=$3 and occurred_at >= $4 and occurred_at < $5 and occurred_at >= $7 and expires_at>$6 and not withdrawn and body is not null and human
        order by occurred_at desc,message_key limit 401`,
          [
            key,
            this.revision(policy),
            this.config.restoreEpoch,
            new Date(start),
            new Date(end),
            now,
            p.floor_at
          ]
        )
      ).rows;
      const quote = query.quotedMessageId ? this.hash(key + query.quotedMessageId) : undefined;
      const anchors = quote
        ? (
            await client.query(
              `select message_key,requester_key,occurred_at,body,quoted_key from group_history_message
        where scope=$1 and revision=$2 and restore_epoch=$3 and occurred_at >= $4 and occurred_at < $5 and occurred_at >= $7 and expires_at>$6 and not withdrawn and body is not null and human and (message_key=$8 or quoted_key=$8) order by occurred_at limit 8`,
              [
                key,
                this.revision(policy),
                this.config.restoreEpoch,
                new Date(start),
                new Date(end),
                now,
                p.floor_at,
                quote
              ]
            )
          ).rows
        : [];
      const candidates = [
        ...new Map([...anchors, ...rows.slice(0, 392)].map((r) => [r.message_key, r])).values()
      ];
      const terms =
        query.topic?.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const hits = candidates.filter(
        (r) =>
          r.message_key === quote ||
          r.quoted_key === quote ||
          !terms.length ||
          terms.some((t) => r.body.toLowerCase().includes(t))
      );
      hits.sort(
        (a, b) =>
          Number(b.message_key === quote || b.quoted_key === quote) -
          Number(a.message_key === quote || a.quoted_key === quote)
      );
      const selected = new Map<string, (typeof hits)[number]>();
      for (const hit of hits) {
        selected.set(hit.message_key, hit);
        const index = candidates.indexOf(hit);
        for (const next of candidates.slice(Math.max(0, index - 1), index + 2))
          selected.set(next.message_key, next);
        if (selected.size >= 10) break;
      }
      const quotedKeys = [...selected.values()].flatMap((r) =>
        r.quoted_key ? [r.quoted_key] : []
      );
      if (quote) quotedKeys.push(quote);
      const safeAnchors = quotedKeys.length
        ? (
            await client.query(
              `select message_key,requester_key,occurred_at,body,dependencies,false as human from group_history_message
        where scope=$1 and revision=$2 and restore_epoch=$3 and not human and not withdrawn and expires_at>$4 and occurred_at >= greatest($5::timestamptz,$7::timestamptz) and occurred_at < $8 and message_key=any($6::text[]) limit 10`,
              [
                key,
                this.revision(policy),
                this.config.restoreEpoch,
                now,
                p.floor_at,
                quotedKeys,
                new Date(start),
                new Date(end)
              ]
            )
          ).rows
        : [];
      const anchorDependencies: string[] = [];
      for (const anchor of safeAnchors) {
        const deps = (anchor.dependencies ?? []) as HistoryDependency[];
        if (!(await Promise.all(deps.map((d) => this.validate(scope, d)))).every(Boolean)) continue;
        selected.set(anchor.message_key, anchor);
        anchorDependencies.push(...deps.flatMap((d) => d.keys));
      }
      let chars = 0;
      const speakers = new Map<string, string>();
      const records = [...selected.values()]
        .slice(0, 10)
        .sort((a, b) => a.occurred_at - b.occurred_at)
        .flatMap((r) => {
          // 1,000 UTF-8 bytes is a conservative <=1,000-token bound; stricter 2,000-character tool cap also applies.
          const size = Buffer.byteLength(r.body) + 100;
          if (chars + size > 1000) return [];
          chars += size;
          if (r.human === false) r.requester_key = "bot-reference";
          if (!speakers.has(r.requester_key))
            speakers.set(r.requester_key, `speaker-${speakers.size + 1}`);
          return [
            {
              key: r.message_key,
              speaker: r.human === false ? "bot-reference" : speakers.get(r.requester_key)!,
              at: r.occurred_at.toISOString(),
              text: r.body
            }
          ];
        });
      const coverage = (
        await client.query(
          `select min(occurred_at) as first,max(occurred_at) as last from group_history_message
        where scope=$1 and revision=$2 and restore_epoch=$3 and human and not withdrawn and expires_at>$4 and occurred_at >= $5`,
          [key, this.revision(policy), this.config.restoreEpoch, now, p.floor_at]
        )
      ).rows[0];
      return {
        status: records.length ? "success" : hits.length ? "unavailable" : "not_found",
        start: query.start,
        end: query.end,
        incomplete: true,
        coverage: {
          retainedFrom: coverage.first?.toISOString() ?? null,
          retainedUntil: coverage.last?.toISOString() ?? null,
          hasGaps: true
        },
        records,
        dependency: {
          scope: key,
          revision: this.revision(policy),
          epoch: this.config.restoreEpoch,
          keys: [...new Set([...records.map((r) => r.key), ...anchorDependencies])]
        }
      };
    });
  }
  async recordReply(
    scope: HistoryScope,
    messages: Array<{ id: string; text: string }>,
    dependencies: HistoryDependency[] = []
  ): Promise<void> {
    if (!(await Promise.all(dependencies.map((d) => this.validate(scope, d)))).every(Boolean))
      return;
    for (const message of messages.slice(0, 5)) {
      const text = safeQuoteText(
        message.text.replace(/https?:\/\/[^\s<>]+/giu, "[連結省略]")
      )?.slice(0, 200);
      if (!text) continue;
      await this.ingest(
        scope,
        { type: "message", timestamp: Date.now(), message: { type: "text", id: message.id, text } },
        dependencies
      );
    }
  }
  async validate(scope: HistoryScope, dependency: HistoryDependency): Promise<boolean> {
    const policy = this.policy(scope);
    if (
      !policy ||
      !(await this.authorize(scope).catch(() => false)) ||
      dependency.scope !== this.scope(scope) ||
      dependency.revision !== this.revision(policy) ||
      dependency.epoch !== this.config.restoreEpoch
    )
      return false;
    return this.transaction(async (client) => {
      if (!(await this.current(client))) return false;
      const result = await client.query(
        `select count(*)::int as n from group_history_message m join group_history_policy p using(scope)
        where m.scope=$1 and p.enabled and p.revision=$2 and p.restore_epoch=$3 and m.revision=p.revision and m.restore_epoch=p.restore_epoch
        and message_key=any($4::text[]) and occurred_at>=p.floor_at and not withdrawn and expires_at>now()`,
        [dependency.scope, dependency.revision, dependency.epoch, dependency.keys]
      );
      const live = await client.query(
        "select 1 from group_history_policy where scope=$1 and revision=$2 and restore_epoch=$3 and enabled",
        [dependency.scope, dependency.revision, dependency.epoch]
      );
      return Boolean(live.rowCount) && result.rows[0].n === dependency.keys.length;
    });
  }
  async purge() {
    await this.transaction(async (client) => {
      await client.query(`delete from group_history_message where (scope,message_key) in
      (select m.scope,message_key from group_history_message m join group_history_policy p using(scope) where expires_at<=now() or not p.enabled or m.revision<>p.revision or m.restore_epoch<>p.restore_epoch limit 200)`);
    });
  }
}
