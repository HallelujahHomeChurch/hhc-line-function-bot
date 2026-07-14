# Guided Attachment Save Flow Design

## Goal

Replace the current attachment-purpose prompt with a controlled, requester-scoped wizard. The bot must obtain explicit opt-in, one of four supported purposes, and a user-entered title before showing the existing final save confirmation.

All conversational bot-authored self-reference uses first-person wording such as `我`. The bot must not refer to itself as `小哈` in the third person. Product identity (`我是小哈`), wake words, user examples, registration phrases, and the destination name `小哈資料庫` retain the product name.

## User Flow

1. An authorized requester uploads a supported LINE image or file.
2. The bot stores attachment metadata only and asks `要我幫忙保存這個檔案嗎？` with `是` and `否` quick replies.
3. `否` deletes the pending session. `是` advances to purpose selection.
4. The bot asks `這個檔案要保存成哪一種用途？` with exactly four quick replies:
   - `投影片`
   - `流行歌譜`
   - `詩歌歌譜`
   - `小哈資料庫`
5. A valid purpose checks that its target source is enabled and writable, stores only the selected target metadata, and asks `請輸入這份檔案的名稱。`
6. The next non-empty requester message is the title. The bot stores the title and shows the existing metadata preview with `保存` and `取消` quick replies.
7. Only `保存` downloads the LINE content, validates size and content, scans it, uploads it to OneDrive, and upserts catalog metadata. `取消` deletes the session without downloading.

`教會資料` remains an accepted typed alias for `小哈資料庫`, but it is not a fifth quick-reply choice.

## State Model

`PendingAttachmentSession.stage` becomes an explicit four-stage state machine:

- `awaiting_opt_in`
- `awaiting_purpose`
- `awaiting_title`
- `awaiting_confirmation`

The session remains scoped by profile, LINE source, and requester user ID. Every successful transition refreshes the existing ten-minute expiry. Another group member cannot continue the flow.

Purpose selection stores a destination without inventing a title. Title input is required and cannot fall back silently to the original file name. Empty input re-prompts. Cancel phrases are accepted at every stage.

## Target Mapping

| Choice     | Source             | Item kind                        | Query function     |
| ---------- | ------------------ | -------------------------------- | ------------------ |
| 投影片     | `ppt_slides`       | `ppt_slide`                      | `find_ppt_slides`  |
| 流行歌譜   | `pop_sheet_music`  | `pop_sheet`                      | `find_sheet_music` |
| 詩歌歌譜   | `hymn_sheet_music` | `hymn_sheet`                     | `find_sheet_music` |
| 小哈資料庫 | `xiaoha_database`  | content-derived church item kind | `find_resource`    |

## Safety And Error Handling

- Effective `save_resource` permission is checked before creating the session.
- Declared oversize attachments are rejected before the wizard starts.
- No attachment bytes are downloaded before final confirmation.
- A missing or non-writable target fails closed and clears the session.
- Unexpected input at opt-in, purpose, or confirmation re-prompts with the relevant quick replies.
- Existing MIME/magic-byte, extension, hash, duplicate, ClamAV, OneDrive, and catalog behavior remains unchanged.

## Tests

Automated tests cover:

- Initial upload creates `awaiting_opt_in` and displays yes/no quick replies.
- No/取消 clears the session without downloading.
- Yes advances to four purpose choices without downloading.
- Each purpose maps to the correct destination and advances to title collection.
- Typed `教會資料` maps to `小哈資料庫`.
- Empty title re-prompts; a valid title advances to preview.
- Preview contains user title, original file name, type, and size.
- Final save is the only transition that downloads, scans, uploads, and indexes.
- State remains requester-scoped in groups.
- All prompts in this flow use first-person self-reference.

## Out Of Scope

- Changing supported file formats, size limits, virus scanning, OneDrive folders, catalog retention, or resource query behavior.
- Changing HTTPS link saves or external sheet-music import sessions.
- Adding Flex Messages or a separate form UI.
