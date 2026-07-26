import { InMemoryAccessStore } from "../../../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../../../access/registration-invite-code-store.js";
import { InMemoryAgentJobStore } from "../../../agent/jobs.js";
import { InMemoryConversationWindowStore } from "../../../agent/context-manager.js";
import { InMemoryAgentMemoryStore } from "../../../agent/memory-store.js";
import { resolveEffectiveAccessContext } from "../../../application/access/effective-access.js";
import { renderCapabilityHelp } from "../../../application/capabilities/capability-presenters.js";
import { projectEffectiveCapabilities } from "../../../application/capabilities/effective-capability-projection.js";
import {
  applyResultGuidance,
  type ControlledResultState
} from "../../../application/turn/result-guidance.js";
import { InMemoryCatalogStore } from "../../../catalog/store.js";
import { getFunctionDefinition } from "../../../functions/definitions.js";
import { InMemoryKnowledgeStore } from "../../../knowledge/store.js";
import { messages } from "../../../messages.js";
import { InMemoryScheduleStore } from "../../../schedules/store.js";
import { InMemorySessionStore } from "../../../state/session-store.js";
import {
  handlePublicAccessCommand,
  type PublicAccessCommandPolicies
} from "../../../transport/line/public-access-commands.js";
import type {
  AgentPlanRecord,
  BotProfileConfig,
  FunctionExecutionResult,
  FunctionName,
  FunctionRegistry,
  LineEvent,
  LineSource
} from "../../../types.js";
import type {
  KernelAcceptanceCase,
  KernelBoundary,
  KernelCaseObservation,
  KernelJourney,
  RecurrenceFamily
} from "../contracts.js";
import { createKernelRuntimeHarness } from "../runtime-harness.js";

const PROFILE_NAME = "helper";
const GROUP_ALPHA = "G_BRANCH_ALPHA";
const GROUP_BETA = "G_BRANCH_BETA";
const REQUESTER = "U_BRANCH_MEMBER";
const PRODUCT_PREFIX = "kernel-v1/product_experience";
const PROFILE_FUNCTIONS: FunctionName[] = [
  "find_sheet_music",
  "query_schedule",
  "save_memory",
  "save_resource"
];

export const PRODUCT_EXPERIENCE_KERNEL_CASES: KernelAcceptanceCase[] = [
  discoveryCase("effective-discovery-direct", "direct"),
  discoveryCase("effective-discovery-group", "group"),
  discoveryCase("effective-discovery-granted-user", "granted_user"),
  discoveryCase("effective-discovery-admin", "admin"),
  registrationFirstReadCase(),
  resultGuidanceClassesCase(),
  branchGroupIsolationCase()
];

type DiscoveryKind = "direct" | "group" | "granted_user" | "admin";

interface ExpectedDiscovery {
  effective: FunctionName[];
  reads: FunctionName[];
  writes: FunctionName[];
  displayed: string[];
  omitted: string[];
}

const expectedDiscovery: Record<DiscoveryKind, ExpectedDiscovery> = {
  direct: {
    effective: ["find_sheet_music", "query_schedule"],
    reads: ["query_schedule", "find_sheet_music"],
    writes: [],
    displayed: ["查服事表", "查歌譜"],
    omitted: ["查投影片", "記住資訊", "保存連結資源"]
  },
  group: {
    effective: ["find_sheet_music", "query_schedule", "find_ppt_slides"],
    reads: ["find_ppt_slides", "query_schedule", "find_sheet_music"],
    writes: [],
    displayed: ["查投影片", "查服事表", "查歌譜"],
    omitted: ["記住資訊", "保存連結資源"]
  },
  granted_user: {
    effective: ["find_sheet_music", "query_schedule", "save_memory"],
    reads: ["query_schedule", "find_sheet_music"],
    writes: ["save_memory"],
    displayed: ["查服事表", "查歌譜", "記住資訊"],
    omitted: ["查投影片", "保存連結資源"]
  },
  admin: {
    effective: PROFILE_FUNCTIONS,
    reads: ["query_schedule", "find_sheet_music"],
    writes: ["save_memory", "save_resource"],
    displayed: ["查服事表", "查歌譜", "記住資訊", "保存連結資源"],
    omitted: ["查投影片"]
  }
};

function discoveryCase(slug: string, kind: DiscoveryKind): KernelAcceptanceCase {
  const id = `${PRODUCT_PREFIX}/${slug}@1`;
  return acceptanceCase(id, "resource", "write_safety_bypass", "response_projection", async () => {
    const fixture = await discoveryFixture(kind);
    const access = await resolveEffectiveAccessContext({
      profile: profile(PROFILE_FUNCTIONS),
      event: fixture.event,
      accessStore: fixture.store
    });
    const projection = projectEffectiveCapabilities({ context: access });
    const help = renderCapabilityHelp(projection, "help");
    const expected = expectedDiscovery[kind];
    const passed =
      access.authorized &&
      sameValues(access.profile.enabledFunctions, expected.effective) &&
      sameValues(
        projection.reads.map(({ functionName }) => functionName),
        expected.reads
      ) &&
      sameValues(
        projection.writes.map(({ functionName }) => functionName),
        expected.writes
      ) &&
      expected.displayed.every((label) => help.replyText.includes(`- ${label}：`)) &&
      expected.omitted.every((label) => !help.replyText.includes(`- ${label}：`)) &&
      (help.quickReplies?.length ?? 0) <= 3 &&
      expected.writes.length > 0 === help.replyText.includes("可以保存或更新");

    return observation({
      id,
      boundary: "response_projection",
      recurrenceFamily: "write_safety_bypass",
      passed,
      elapsedMs: 1
    });
  });
}

async function discoveryFixture(
  kind: DiscoveryKind
): Promise<{ event: LineEvent; store: InMemoryAccessStore }> {
  const store = new InMemoryAccessStore();
  if (kind === "group") {
    await store.addPrincipal({
      profileName: PROFILE_NAME,
      type: "group",
      principalId: GROUP_ALPHA,
      createdBy: "synthetic-admin"
    });
    await store.addGroupFunctionGrant({
      profileName: PROFILE_NAME,
      groupId: GROUP_ALPHA,
      functionName: "find_ppt_slides",
      createdBy: "synthetic-admin"
    });
    return {
      event: textEvent({ type: "group", groupId: GROUP_ALPHA, userId: REQUESTER }),
      store
    };
  }

  const userId = kind === "admin" ? "U_SYNTHETIC_ADMIN" : REQUESTER;
  if (kind !== "admin") {
    await store.addPrincipal({
      profileName: PROFILE_NAME,
      type: "user",
      principalId: userId,
      createdBy: "synthetic-admin"
    });
  }
  if (kind === "granted_user") {
    await store.addUserFunctionGrant({
      profileName: PROFILE_NAME,
      userId,
      functionName: "save_memory",
      createdBy: "synthetic-admin"
    });
  }
  return {
    event: textEvent({ type: "user", userId }),
    store
  };
}

function registrationFirstReadCase(): KernelAcceptanceCase {
  const id = `${PRODUCT_PREFIX}/registration-first-read@1`;
  return acceptanceCase(
    id,
    "schedule",
    "required_slot_misrouted",
    "entrance_access",
    async (context) => {
      const store = new InMemoryAccessStore();
      const event = textEvent({ type: "user", userId: REQUESTER });
      const registrationProfile = {
        ...profile(["query_schedule"]),
        registration: { enabled: true }
      };
      const before = await resolveEffectiveAccessContext({
        profile: registrationProfile,
        event,
        accessStore: store
      });
      const inviteCodes = new InMemoryRegistrationInviteCodeStore({
        codeFactory: () => "R41TEST",
        now: context.now
      });
      await inviteCodes.create({
        profileName: PROFILE_NAME,
        createdBy: "U_SYNTHETIC_ADMIN",
        ttlMinutes: 60,
        now: context.now()
      });
      const completion = await handlePublicAccessCommand({
        text: "/registry R41TEST",
        profile: registrationProfile,
        event,
        accessStore: store,
        registrationInviteCodeStore: inviteCodes,
        lineIdentity: {
          getUserDisplayName: async () => "Synthetic member",
          getGroupDisplayName: async () => undefined
        },
        adminHandlers: {},
        productContext: { requestId: `${id}-registration` },
        policies: publicAccessPolicies,
        resolveCurrentAccess: async () =>
          resolveEffectiveAccessContext({
            profile: registrationProfile,
            event,
            accessStore: store
          })
      });
      const after = await resolveEffectiveAccessContext({
        profile: registrationProfile,
        event,
        accessStore: store
      });
      const firstAction = completion?.quickReplies?.[0]?.action;
      const text = firstAction?.type === "message" ? firstAction.text : undefined;
      let executions = 0;
      const functions: FunctionRegistry = {
        query_schedule: async (_arguments, handlerContext) => {
          if (handlerContext.event.source.type !== "user") {
            return controlledResult("unavailable", "synthetic wrong source");
          }
          executions += 1;
          return controlledResult("success", "下一場服事：合成資料");
        }
      };
      const harness = createKernelRuntimeHarness({
        now: context.now,
        profile: after.profile,
        functionRegistry: functions,
        planner: executePlanner("query_schedule", { query: text ?? "" })
      });
      const [result] = text
        ? await harness.runTurns([
            {
              text,
              requesterUserId: REQUESTER,
              requestId: `${id}-first-read`,
              source: { type: "user", userId: REQUESTER }
            }
          ])
        : [];
      const passed =
        !before.authorized &&
        after.authorized &&
        completion?.replyText.includes("已開通，你現在可以使用小哈。") === true &&
        text === "小哈 下一場服事表" &&
        executions === 1 &&
        result?.resultStatus === "success";

      return observation({
        id,
        boundary: "entrance_access",
        recurrenceFamily: "required_slot_misrouted",
        passed,
        elapsedMs: result?.elapsedMs ?? 1
      });
    }
  );
}

const publicAccessPolicies: PublicAccessCommandPolicies = {
  parseCommand(text) {
    const [command, ...args] = text?.trim().split(/\s+/u) ?? [];
    return command?.startsWith("/") ? { command: command.slice(1), args } : undefined;
  },
  adminAllowed: async () => false,
  formatAdminHelp: () => "",
  directAccessPolicy: (currentProfile) => currentProfile.directAccessPolicy ?? "blocked",
  groupAccessPolicy: (currentProfile) => currentProfile.groupAccessPolicy ?? "blocked",
  isBootstrapSuperAdmin: (currentProfile, userId) => currentProfile.adminUserId === userId,
  isAdminUser: async (currentProfile, userId, store) =>
    Boolean(
      userId &&
      (currentProfile.adminUserId === userId ||
        (await store.hasActivePrincipal(currentProfile.name, "admin", userId)))
    ),
  isDirectUserAllowed: async (currentProfile, userId, store) =>
    Boolean(
      userId &&
      (currentProfile.directAccessPolicy === "public" ||
        currentProfile.adminUserId === userId ||
        (await store.hasActivePrincipal(currentProfile.name, "admin", userId)) ||
        (await store.hasActivePrincipal(currentProfile.name, "user", userId)))
    ),
  isGroupAllowed: async (currentProfile, groupId, store) =>
    Boolean(groupId && (await store.hasActivePrincipal(currentProfile.name, "group", groupId)))
};

function resultGuidanceClassesCase(): KernelAcceptanceCase {
  const id = `${PRODUCT_PREFIX}/result-guidance-classes@1`;
  return acceptanceCase(
    id,
    "resource",
    "unavailable_presented_as_not_found",
    "response_projection",
    async () => {
      const ambiguityChoice = {
        label: "第一項",
        action: { type: "message" as const, label: "第一項", text: "1" }
      };
      const definition = getFunctionDefinition("query_schedule");
      const samples: Array<{
        state: ControlledResultState;
        result: FunctionExecutionResult;
        check: (guided: FunctionExecutionResult) => boolean;
      }> = [
        {
          state: "permission_denied",
          result: { ok: true, replyText: "" },
          check: (guided) =>
            guided.replyText === messages.permissionDenied &&
            guided.quickReplies?.[0]?.label === "查看可用功能"
        },
        {
          state: "missing_input",
          result: { ok: true, replyText: "" },
          check: (guided) =>
            guided.replyText ===
              `${definition?.clarificationPrompt}\n${messages.missingInputNextAction}` &&
            (guided.quickReplies?.length ?? 0) === 0
        },
        {
          state: "ambiguous",
          result: {
            ...controlledResult("ambiguous", "請選擇一個符合項目。"),
            quickReplies: [ambiguityChoice]
          },
          check: (guided) =>
            guided.replyText === "請選擇一個符合項目。" &&
            guided.quickReplies?.[0] === ambiguityChoice
        },
        {
          state: "not_found",
          result: controlledResult("not_found", ""),
          check: (guided) => guided.replyText === messages.notFoundGuidance
        },
        {
          state: "unavailable",
          result: controlledResult("unavailable", ""),
          check: (guided) => guided.replyText === messages.unavailableGuidance
        },
        {
          state: "stale_allowed",
          result: controlledResult("success", "合成舊資料"),
          check: (guided) =>
            guided.replyText ===
            `合成舊資料\n資料時間：2026-07-26T07:00:00.000Z。${messages.staleGuidance}`
        },
        {
          state: "success",
          result: controlledResult("success", "合成新資料"),
          check: (guided) => guided.replyText === "合成新資料"
        },
        {
          state: "error",
          result: { ok: false, replyText: "處理失敗（支援碼：SAFE123）" },
          check: (guided) => guided.replyText === "處理失敗（支援碼：SAFE123）"
        }
      ];
      const guided = samples.map((sample) => ({
        sample,
        result: applyResultGuidance({
          state: sample.state,
          result: sample.result,
          definition,
          staleAt: sample.state === "stale_allowed" ? "2026-07-26T07:00:00.000Z" : undefined
        })
      }));
      const output = guided
        .map(({ result }) => result.replyText)
        .join("\n")
        .toLowerCase();
      const passed =
        guided.length === 8 &&
        guided.every(
          ({ sample, result }) => sample.check(result) && (result.quickReplies?.length ?? 0) <= 1
        ) &&
        [
          "deepseek",
          "openai",
          "onedrive",
          "notion",
          "postgres",
          "redis",
          "provider",
          "model",
          "source id"
        ].every((term) => !output.includes(term));

      return observation({
        id,
        boundary: "response_projection",
        recurrenceFamily: "unavailable_presented_as_not_found",
        passed,
        unavailableEligible: true,
        unavailableMisclassified: !passed
      });
    }
  );
}

function branchGroupIsolationCase(): KernelAcceptanceCase {
  const id = `${PRODUCT_PREFIX}/branch-group-isolation@1`;
  return acceptanceCase(
    id,
    "memory",
    "group_requester_scope_leak",
    "active_task_lifecycle",
    async (context) => {
      const now = context.now();
      const fixture = await createBranchFixture(now);
      const shared = await sharedFormalDataVisible(fixture);
      const isolated = await scopedInteractionDataIsolated(fixture, now);
      const passed = shared && isolated;
      return observation({
        id,
        boundary: "active_task_lifecycle",
        recurrenceFamily: "group_requester_scope_leak",
        passed,
        securityViolation: "scope_leak"
      });
    }
  );
}

interface BranchFixture {
  schedule: InMemoryScheduleStore;
  catalog: InMemoryCatalogStore;
  knowledge: InMemoryKnowledgeStore;
  sessions: InMemorySessionStore;
  jobs: InMemoryAgentJobStore;
  memory: InMemoryAgentMemoryStore;
  conversations: InMemoryConversationWindowStore;
  alpha: LineSource;
  beta: LineSource;
}

async function createBranchFixture(now: Date): Promise<BranchFixture> {
  const schedule = new InMemoryScheduleStore();
  await schedule.upsertItem({
    profileName: PROFILE_NAME,
    sourceKey: "shared_schedule",
    origin: "notion",
    externalKey: "shared-event",
    serviceDate: "2026-07-27",
    meeting: "主日",
    role: "音控",
    assignee: "合成人員"
  });

  const catalog = new InMemoryCatalogStore();
  const catalogSource = await catalog.upsertSource({
    profileName: PROFILE_NAME,
    sourceKey: "shared_catalog",
    adapterType: "onedrive",
    domain: "general",
    defaultItemKind: "general_resource",
    rootLocation: { driveId: "synthetic-drive", folderItemId: "synthetic-folder" },
    enabled: true,
    syncPolicy: { mode: "scheduled", intervalMinutes: 60 },
    capabilities: { read: [PROFILE_NAME, "find_resource"], write: [] }
  });
  await catalog.publishSourceSnapshot({
    sourceId: catalogSource.id,
    expectedRevision: catalogSource.revision,
    publishedAt: now.toISOString(),
    items: [
      {
        sourceId: catalogSource.id,
        itemKind: "general_resource",
        domain: "general",
        title: "共享資料",
        storageRef: {
          provider: "graph",
          driveId: "synthetic-drive",
          itemId: "synthetic-item"
        }
      }
    ]
  });

  const knowledge = new InMemoryKnowledgeStore(() => now);
  const knowledgeSource = await knowledge.upsertSource({
    profileName: PROFILE_NAME,
    sourceKey: "shared_knowledge",
    displayName: "共享知識",
    adapterType: "notion",
    externalRootId: "synthetic-root",
    rootUrl: "https://example.invalid/shared",
    enabled: true,
    aliases: ["共享知識"],
    topics: ["共享主題"],
    sampleQueries: ["查共享主題"]
  });
  await knowledge.replaceDocument({
    sourceId: knowledgeSource.id,
    externalId: "shared-document",
    title: "共享文件",
    url: "https://example.invalid/shared-document",
    nodes: [],
    chunks: [
      {
        headingPath: ["共享主題"],
        ordinal: 0,
        content: "共享知識內容",
        contentHash: "shared-hash"
      }
    ]
  });
  await knowledge.updateSource({
    profileName: PROFILE_NAME,
    sourceKey: "shared_knowledge",
    syncStatus: "ready",
    lastSyncedAt: now.toISOString()
  });

  return {
    schedule,
    catalog,
    knowledge,
    sessions: new InMemorySessionStore({ now: () => now }),
    jobs: new InMemoryAgentJobStore({ now: () => now }),
    memory: new InMemoryAgentMemoryStore({ now: () => now }),
    conversations: new InMemoryConversationWindowStore({ now: () => now }),
    alpha: { type: "group", groupId: GROUP_ALPHA, userId: REQUESTER },
    beta: { type: "group", groupId: GROUP_BETA, userId: REQUESTER }
  };
}

async function sharedFormalDataVisible(fixture: BranchFixture): Promise<boolean> {
  const scheduleAlpha = await fixture.schedule.searchItems({
    profileName: PROFILE_NAME,
    query: "合成人員"
  });
  const scheduleBeta = await fixture.schedule.searchItems({
    profileName: PROFILE_NAME,
    query: "合成人員"
  });
  const catalogAlpha = await fixture.catalog.searchItems({
    profileName: PROFILE_NAME,
    query: "共享資料"
  });
  const catalogBeta = await fixture.catalog.searchItems({
    profileName: PROFILE_NAME,
    query: "共享資料"
  });
  const knowledgeAlpha = await fixture.knowledge.search({
    profileName: PROFILE_NAME,
    query: "共享知識內容"
  });
  const knowledgeBeta = await fixture.knowledge.search({
    profileName: PROFILE_NAME,
    query: "共享知識內容"
  });
  return (
    scheduleAlpha.length === 1 &&
    scheduleBeta[0]?.id === scheduleAlpha[0]?.id &&
    catalogAlpha.length === 1 &&
    catalogBeta[0]?.id === catalogAlpha[0]?.id &&
    knowledgeAlpha.length === 1 &&
    knowledgeBeta[0]?.id === knowledgeAlpha[0]?.id
  );
}

async function scopedInteractionDataIsolated(fixture: BranchFixture, now: Date): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const sessionRequester = "U_BRANCH_SESSION";
  const alphaSessionSource = { ...fixture.alpha, userId: sessionRequester };
  const betaSessionSource = { ...fixture.beta, userId: sessionRequester };
  await fixture.sessions.set({
    id: "alpha-pending",
    type: "pending_function",
    action: "save_memory",
    profileName: PROFILE_NAME,
    requesterUserId: sessionRequester,
    source: alphaSessionSource,
    arguments: { content: "synthetic" },
    expiresAt
  });
  await fixture.sessions.set({
    id: "alpha-selection",
    type: "selection",
    action: "find_resource",
    profileName: PROFILE_NAME,
    requesterUserId: REQUESTER,
    source: fixture.alpha,
    items: [{ id: "synthetic-item", name: "共享資料", driveId: "synthetic-drive" }],
    expiresAt
  });
  await fixture.sessions.set({
    id: "alpha-attachment",
    type: "pending_attachment",
    action: "save_resource",
    stage: "awaiting_confirmation",
    profileName: PROFILE_NAME,
    requesterUserId: REQUESTER,
    source: fixture.alpha,
    attachment: { messageId: "synthetic-message", messageType: "file" },
    expiresAt
  });

  const alphaJobScope = {
    profileName: PROFILE_NAME,
    sourceKey: `group:${GROUP_ALPHA}`,
    requesterUserId: REQUESTER
  };
  const job = await fixture.jobs.createPending({
    scope: alphaJobScope,
    label: "synthetic",
    ttlMs: 60_000
  });
  await fixture.memory.saveTextMemory({
    profileName: PROFILE_NAME,
    source: fixture.alpha,
    createdBy: REQUESTER,
    visibility: "group",
    content: "alpha only",
    query: "alpha"
  });
  await fixture.conversations.recordActiveTask({
    scope: alphaJobScope,
    task: {
      version: 2,
      currentCapability: "find_resource",
      allowedCapabilities: ["find_resource"],
      anchors: { resourceId: "synthetic-resource" },
      entities: [{ type: "resource", key: "synthetic-resource", label: "資料" }],
      supportedOperations: ["continue"],
      createdAt: now.toISOString(),
      expiresAt
    },
    ttlMs: 60_000
  });

  const betaLookup = {
    profileName: PROFILE_NAME,
    source: fixture.beta,
    requesterUserId: REQUESTER
  };
  const [
    alphaPending,
    betaPending,
    alphaSelection,
    betaSelection,
    alphaAttachment,
    betaAttachment,
    alphaJob,
    betaJob,
    alphaMemory,
    betaMemory,
    alphaTask,
    betaTask
  ] = await Promise.all([
    fixture.sessions.findPendingFunction({
      profileName: PROFILE_NAME,
      source: alphaSessionSource,
      requesterUserId: sessionRequester,
      action: "save_memory"
    }),
    fixture.sessions.findPendingFunction({
      profileName: PROFILE_NAME,
      source: betaSessionSource,
      requesterUserId: sessionRequester,
      action: "save_memory"
    }),
    fixture.sessions.findSelection({
      profileName: PROFILE_NAME,
      source: fixture.alpha,
      requesterUserId: REQUESTER,
      action: "find_resource"
    }),
    fixture.sessions.findSelection({ ...betaLookup, action: "find_resource" }),
    fixture.sessions.findPendingAttachment({
      profileName: PROFILE_NAME,
      source: fixture.alpha,
      requesterUserId: REQUESTER
    }),
    fixture.sessions.findPendingAttachment(betaLookup),
    fixture.jobs.get(job.id, alphaJobScope),
    fixture.jobs.get(job.id, {
      profileName: PROFILE_NAME,
      sourceKey: `group:${GROUP_BETA}`,
      requesterUserId: REQUESTER
    }),
    fixture.memory.searchTextMemories({
      profileName: PROFILE_NAME,
      source: fixture.alpha,
      requesterUserId: REQUESTER,
      query: "alpha"
    }),
    fixture.memory.searchTextMemories({
      profileName: PROFILE_NAME,
      source: fixture.beta,
      requesterUserId: REQUESTER,
      query: "alpha"
    }),
    fixture.conversations.activeTask(alphaJobScope),
    fixture.conversations.activeTask({
      profileName: PROFILE_NAME,
      sourceKey: `group:${GROUP_BETA}`,
      requesterUserId: REQUESTER
    })
  ]);

  const checks = {
    pending: Boolean(alphaPending) && !betaPending,
    selection: Boolean(alphaSelection) && !betaSelection,
    attachment: Boolean(alphaAttachment) && !betaAttachment,
    job: Boolean(alphaJob) && !betaJob,
    memory: alphaMemory.length === 1 && betaMemory.length === 0,
    task: Boolean(alphaTask) && !betaTask
  };
  return (
    checks.pending &&
    checks.selection &&
    checks.attachment &&
    checks.job &&
    checks.memory &&
    checks.task
  );
}

function acceptanceCase(
  id: string,
  journey: KernelJourney,
  recurrenceFamily: RecurrenceFamily,
  boundary: KernelBoundary,
  run: (context: { now: () => Date }) => Promise<KernelCaseObservation>
): KernelAcceptanceCase {
  return { id, version: 1, journey, recurrenceFamily, boundary, run };
}

function observation(input: {
  id: string;
  boundary: KernelBoundary;
  recurrenceFamily: RecurrenceFamily;
  passed: boolean;
  elapsedMs?: number;
  unavailableEligible?: boolean;
  unavailableMisclassified?: boolean;
  securityViolation?: "scope_leak";
}): KernelCaseObservation {
  return {
    caseId: input.id,
    passed: input.passed,
    boundary: input.boundary,
    recurrenceFamily: input.recurrenceFamily,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: input.passed,
    unavailableEligible: input.unavailableEligible ?? false,
    unavailableMisclassified: input.unavailableMisclassified ?? false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: input.passed || !input.securityViolation ? [] : [input.securityViolation],
    performanceEligible: true,
    elapsedMs: input.elapsedMs ?? 1,
    returnedRetrievableJob: false
  };
}

function profile(enabledFunctions: FunctionName[]): BotProfileConfig {
  return {
    name: PROFILE_NAME,
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "synthetic-secret",
    channelAccessToken: "synthetic-token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: true,
    enabledFunctions,
    adminUserId: "U_SYNTHETIC_ADMIN",
    adminDirectOnly: true,
    directAccessPolicy: "managed",
    groupAccessPolicy: "managed",
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function textEvent(source: LineSource): LineEvent {
  return {
    type: "message",
    replyToken: "synthetic-reply-token",
    source,
    message: { type: "text", text: "synthetic" }
  };
}

function controlledResult(
  status: "success" | "not_found" | "ambiguous" | "unavailable",
  replyText: string
): FunctionExecutionResult {
  return {
    ok: true,
    replyText,
    agentResult: { status, replyText, entities: [], supportedOperations: [] }
  };
}

function executePlanner(capability: FunctionName, argumentsRecord: AgentPlanRecord) {
  return {
    propose: async () => ({
      status: "proposed" as const,
      version: 1 as const,
      disposition: "execute" as const,
      capability,
      arguments: argumentsRecord,
      confidence: 0.99,
      provider: "deepseek" as const,
      attempts: []
    })
  };
}

function sameValues<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
