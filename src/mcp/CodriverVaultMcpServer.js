const CODRIVER_INTERNAL_TRANSPORT = "codriver";
const CODRIVER_VAULT_SERVER_ID = "codriver-vault";
const CODRIVER_VAULT_SERVER_NAME = "CoDriver Vault";
const CODRIVER_ACTIVE_FILE_GET_PATH_TOOL_NAME = "codriver_active_file_get_path";
const CODRIVER_OPEN_FILE_TOOL_NAME = "codriver_open_file";
const CODRIVER_TAG_LIST_TOOL_NAME = "codriver_tag_list";
const CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME = "codriver_vault_create_note";
const CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME = "codriver_vault_delete_note";
const CODRIVER_VAULT_DOCUMENT_MAP_TOOL_NAME = "codriver_vault_get_document_map";
const CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME = "codriver_vault_append_note";
const CODRIVER_VAULT_LIST_TOOL_NAME = "codriver_vault_list";
const CODRIVER_VAULT_MOVE_FILE_TOOL_NAME = "codriver_vault_move_file";
const CODRIVER_VAULT_PATCH_NOTE_TOOL_NAME = "codriver_vault_patch_note";
const CODRIVER_VAULT_READ_TOOL_NAME = "codriver_vault_read";
const CODRIVER_VAULT_READ_TARGET_TOOL_NAME = "codriver_vault_read_target";
const CODRIVER_VAULT_SEARCH_TOOL_NAME = "codriver_vault_search";
const CODRIVER_VAULT_SEARCH_STRUCTURED_TOOL_NAME = "codriver_vault_search_structured";
const VAULT_AUDIO_AUTO_CONSENT_VERSION = 1;
const CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME = "codriver_vault_transcribe_audio";
const CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES = Object.freeze([
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME,
  CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME,
  CODRIVER_VAULT_PATCH_NOTE_TOOL_NAME,
  CODRIVER_VAULT_MOVE_FILE_TOOL_NAME,
  CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME
]);
const CODRIVER_VAULT_TOOL_NAMES = Object.freeze([
  ...CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES,
  CODRIVER_ACTIVE_FILE_GET_PATH_TOOL_NAME,
  CODRIVER_VAULT_LIST_TOOL_NAME,
  CODRIVER_VAULT_READ_TOOL_NAME,
  CODRIVER_VAULT_READ_TARGET_TOOL_NAME,
  CODRIVER_VAULT_SEARCH_TOOL_NAME,
  CODRIVER_VAULT_SEARCH_STRUCTURED_TOOL_NAME,
  CODRIVER_VAULT_DOCUMENT_MAP_TOOL_NAME,
  CODRIVER_TAG_LIST_TOOL_NAME,
  CODRIVER_OPEN_FILE_TOOL_NAME
]);
const CODRIVER_VAULT_TOOL_ORDER = new Map(
  CODRIVER_VAULT_TOOL_NAMES.map((name, index) => [name, index])
);

function createCodriverVaultMcpServer(options = {}) {
  const toolSettings = options?.toolSettings && typeof options.toolSettings === "object"
    ? options.toolSettings
    : {};
  return {
    id: CODRIVER_VAULT_SERVER_ID,
    name: CODRIVER_VAULT_SERVER_NAME,
    transport: CODRIVER_INTERNAL_TRANSPORT,
    enabled: true,
    system: true,
    tools: [
      {
        name: CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
        title: "Transcribe vault audio",
        description: "Transcribe one exact existing vault-relative audio file given by path through the audio transcription provider and model selected in CoDriver Settings. Markdown notes, links, URLs, OS paths, and legacy embed arguments are rejected. Use this tool only when no completed direct-attachment transcript for that audio is already present in the current request. Direct audio attachments are transcribed before the task-answering request and do not use this tool. This is read-only for the vault but sends sensitive audio to an external destination. It requires confirmation unless the user explicitly allows this exact tool to run automatically. Auto allows sending any explicitly requested vault audio path to the selected ASR destination without per-call approval.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Exact existing vault-relative audio file path using forward slashes, for example Recordings/Recording.m4a."
            }
          },
          required: ["path"],
          additionalProperties: false
        },
        allowAutomaticExecution: toolSettings[CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME]?.autoConsentVersion === VAULT_AUDIO_AUTO_CONSENT_VERSION &&
          toolSettings[CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME]?.allowAutomaticExecution === true,
        automaticPermissionConfigurable: true
      },
      {
        name: CODRIVER_ACTIVE_FILE_GET_PATH_TOOL_NAME,
        title: "Get active file path",
        description: "Return the vault-relative path of the file currently open in Obsidian. Use this only when the user asks for the active or currently open file. It is not a proxy for the latest, last worked-on, or most recently edited note; use structured search for those requests. This does not read file content.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_VAULT_LIST_TOOL_NAME,
        title: "List vault directory",
        description: "List files and folders under a vault-relative directory path through CoDriver's Obsidian API. This is read-only and returns names, paths, types, and file extensions.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative folder path to list. Omit or use an empty string for the vault root."
            }
          },
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_VAULT_MOVE_FILE_TOOL_NAME,
        title: "Move vault file",
        description: "Move or rename one exact existing vault file to one missing vault-relative file path through Obsidian's link-aware FileManager API. Missing destination folders are created only after authorization and are shown during manual review. Existing files and folders are never overwritten, source state is revalidated before execution, and internal link updates follow the user's Obsidian settings. This changes vault state and requires approval unless the user explicitly allows this exact tool to run automatically.",
        inputSchema: {
          type: "object",
          properties: {
            sourcePath: {
              type: "string",
              description: "Exact existing vault-relative file path using forward slashes."
            },
            destinationPath: {
              type: "string",
              description: "Exact missing vault-relative destination file path using forward slashes. Missing parent folders may be created after authorization."
            }
          },
          required: ["sourcePath", "destinationPath"],
          additionalProperties: false
        },
        allowAutomaticExecution: toolSettings[CODRIVER_VAULT_MOVE_FILE_TOOL_NAME]?.allowAutomaticExecution === true,
        automaticPermissionConfigurable: true,
        writesVault: true
      },
      {
        name: CODRIVER_VAULT_READ_TOOL_NAME,
        title: "Read vault note",
        description: "Read full Markdown content for a vault-relative note path through CoDriver's Obsidian API. Prefer codriver_vault_get_document_map plus codriver_vault_read_target for named heading, section, block, or frontmatter requests; use this full read when broad note content is needed or narrower tools cannot answer. This is read-only and runs automatically for the built-in CoDriver Vault tool set.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative Markdown note path to read."
            }
          },
          required: ["path"],
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME,
        title: "Create note",
        description: "Create a new Markdown note at an exact vault-relative path through CoDriver's Obsidian API. Missing parent folders are created. This tool never overwrites an existing file or folder. It requires approval unless the user has explicitly allowed this tool to run automatically.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Exact vault-relative path for the new Markdown note, including the .md extension."
            },
            content: {
              type: "string",
              description: "Exact initial Markdown content for the new note."
            }
          },
          required: ["path", "content"],
          additionalProperties: false
        },
        allowAutomaticExecution: toolSettings[CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME]?.allowAutomaticExecution === true,
        automaticPermissionConfigurable: true,
        writesVault: true
      },
      {
        name: CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME,
        title: "Delete note",
        description: "Move one existing Markdown note to the vault's local trash through Obsidian's Vault API. This tool never permanently deletes files, never deletes folders or linked attachments, and requires approval unless the user explicitly allows this exact tool to run automatically.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Exact vault-relative path of the existing Markdown note, including the .md extension and using forward slashes."
            }
          },
          required: ["path"],
          additionalProperties: false
        },
        allowAutomaticExecution: toolSettings[CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME]?.allowAutomaticExecution === true,
        automaticPermissionConfigurable: true,
        writesVault: true
      },
      {
        name: CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME,
        title: "Append to note",
        description: "Append Markdown content to the end of an existing vault-relative Markdown note through CoDriver's Obsidian API. This tool never creates a missing note, never overwrites existing content, and requires confirmation unless the user enables automatic execution for this tool.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative path of the existing Markdown note."
            },
            content: {
              type: "string",
              description: "Non-empty Markdown content to append at the current end of the note."
            }
          },
          required: ["path", "content"],
          additionalProperties: false
        },
        allowAutomaticExecution: toolSettings[CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME]?.allowAutomaticExecution === true,
        automaticPermissionConfigurable: true,
        writesVault: true
      },
      {
        name: CODRIVER_VAULT_PATCH_NOTE_TOOL_NAME,
        title: "Patch note",
        description: "Prepare a reviewable patch for an existing Markdown note. By default, CoDriver applies the patch only after the user accepts its proposal card. If the user explicitly enables automatic application for this exact tool, CoDriver applies a newly prepared proposal through the same stale-safe validation path. Use text changes for exact body replacements or before/after objects for frontmatter changes.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Existing vault-relative Markdown note path using forward slashes."
            },
            kind: {
              type: "string",
              enum: ["text", "frontmatter"],
              description: "Patch kind. Use text for note body replacements or frontmatter for property changes."
            },
            changes: {
              type: "array",
              minItems: 1,
              description: "Required for text patches. Each item replaces one exact current text fragment with its proposed replacement.",
              items: {
                type: "object",
                properties: {
                  before: {
                    type: "string",
                    description: "Exact current note text to replace."
                  },
                  after: {
                    type: "string",
                    description: "Replacement text. Use an empty string to remove the matched text."
                  },
                  contextBefore: {
                    type: "string",
                    description: "Optional exact unchanged text immediately before the replacement target."
                  },
                  contextAfter: {
                    type: "string",
                    description: "Optional exact unchanged text immediately after the replacement target."
                  }
                },
                required: ["before", "after"],
                additionalProperties: false
              }
            },
            before: {
              type: "object",
              description: "Required for frontmatter patches. Expected current values for every property being changed. Use null when a property is currently missing."
            },
            after: {
              type: "object",
              description: "Required for frontmatter patches. Proposed values for every property being changed. Use null to remove a property."
            }
          },
          required: ["path", "kind"],
          additionalProperties: false
        },
        allowAutomaticExecution: true,
        allowAutomaticProposalApplication: toolSettings[CODRIVER_VAULT_PATCH_NOTE_TOOL_NAME]?.allowAutomaticExecution === true,
        automaticPermissionConfigurable: true,
        automaticPermissionTarget: "proposal-application",
        writesVault: true
      },
      {
        name: CODRIVER_VAULT_READ_TARGET_TOOL_NAME,
        title: "Read note target",
        description: "Read one heading section, block reference, or frontmatter field from a Markdown note through CoDriver's Obsidian API without reading the whole note. Prefer this for questions about a named section after codriver_vault_get_document_map confirms the target. This is read-only and runs automatically for the built-in CoDriver Vault tool set.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative Markdown note path."
            },
            targetType: {
              type: "string",
              enum: ["heading", "block", "frontmatter"],
              description: "Target kind to read."
            },
            target: {
              type: "string",
              description: "Heading text, block reference ID with or without ^, or frontmatter key."
            }
          },
          required: ["path", "targetType", "target"],
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_VAULT_SEARCH_TOOL_NAME,
        title: "Search vault notes",
        description: "Search Markdown notes in the current vault by ordinary text and return matching vault-relative note paths with short excerpts. Prefer codriver_vault_search_structured when the request includes path, tag, or frontmatter filters. This is read-only.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text query to search for."
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 8 and is capped at 20."
            }
          },
          required: ["query"],
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_VAULT_SEARCH_STRUCTURED_TOOL_NAME,
        title: "Structured vault search",
        description: "Search notes by text, path, tags, frontmatter, or dates. Metadata-only results omit body snippets. For the latest, last worked-on, or most recently edited note, use sortBy modified, sortOrder desc, and maxResults 1. Use created for newest-created requests. This is read-only.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Optional text to match against note content and path."
            },
            pathPrefix: {
              type: "string",
              description: "Optional vault-relative folder or note path prefix. Folder prefixes match only that folder or descendants."
            },
            tags: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Optional tags to require. All specified tags must match. Values may include or omit the leading #."
            },
            frontmatter: {
              type: "object",
              description: "Optional exact comparable frontmatter key/value filters. Scalar values are matched case-insensitively; array expected values must all match.",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                  {
                    type: "array",
                    items: {
                      oneOf: [
                        { type: "string" },
                        { type: "number" },
                        { type: "boolean" }
                      ]
                    }
                  }
                ]
              }
            },
            frontmatterExists: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Optional frontmatter keys that must exist. All specified keys must exist."
            },
            modifiedSince: {
              type: "string",
              description: "Optional earliest modification date as YYYY-MM-DD in the user's local calendar."
            },
            createdSince: {
              type: "string",
              description: "Optional earliest creation date as YYYY-MM-DD in the user's local calendar."
            },
            sortBy: {
              type: "string",
              enum: ["relevance", "modified", "created", "path"],
              description: "Result sort field. Defaults to relevance. Use modified or created for recent-note queries."
            },
            sortOrder: {
              type: "string",
              enum: ["desc", "asc"],
              description: "Result sort direction. Defaults to desc."
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 8 and is capped at 20."
            }
          },
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_VAULT_DOCUMENT_MAP_TOOL_NAME,
        title: "Get note document map",
        description: "Return headings, block IDs, and frontmatter keys for a Markdown note through CoDriver's Obsidian API. Optionally include full frontmatter values or link metadata when needed. Prefer this before a targeted read when the user asks about a named heading, section, block reference, frontmatter key, note properties, or note links. This is read-only.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative Markdown note path."
            },
            includeFrontmatterValues: {
              type: "boolean",
              description: "When true, include all frontmatter values. Defaults to false so the ordinary document map returns only frontmatter key names."
            },
            includeLinks: {
              type: "boolean",
              description: "When true, include outgoing links, backlinks, unresolved links, and embeds from Obsidian metadata without note body snippets. Defaults to false."
            }
          },
          required: ["path"],
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_TAG_LIST_TOOL_NAME,
        title: "List vault tags",
        description: "Return tags known to Obsidian metadata cache with usage counts. This is read-only.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        allowAutomaticExecution: true
      },
      {
        name: CODRIVER_OPEN_FILE_TOOL_NAME,
        title: "Open file in Obsidian",
        description: "Open a vault file in the Obsidian workspace using an exact path from prior context or tool output. For latest or last worked-on note requests, get the path from structured search before calling this tool. This changes only the visible UI and does not write file content.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative file path to open."
            },
            newLeaf: {
              type: "boolean",
              description: "Open in a new leaf when true."
            }
          },
          required: ["path"],
          additionalProperties: false
        },
        allowAutomaticExecution: true
      }
    ].map((tool) => ({
      ...tool,
      enabled: tool.name === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME
        ? true
        : toolSettings[tool.name]?.enabled !== false,
      allowAutomaticExecution: tool.allowAutomaticExecution === true
    })).sort((left, right) => (
      CODRIVER_VAULT_TOOL_ORDER.get(left.name) - CODRIVER_VAULT_TOOL_ORDER.get(right.name)
    ))
  };
}

module.exports = {
  VAULT_AUDIO_AUTO_CONSENT_VERSION,
  CODRIVER_ACTIVE_FILE_GET_PATH_TOOL_NAME,
  CODRIVER_INTERNAL_TRANSPORT,
  CODRIVER_OPEN_FILE_TOOL_NAME,
  CODRIVER_TAG_LIST_TOOL_NAME,
  CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME,
  CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME,
  CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES,
  CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME,
  CODRIVER_VAULT_DOCUMENT_MAP_TOOL_NAME,
  CODRIVER_VAULT_LIST_TOOL_NAME,
  CODRIVER_VAULT_MOVE_FILE_TOOL_NAME,
  CODRIVER_VAULT_PATCH_NOTE_TOOL_NAME,
  CODRIVER_VAULT_READ_TOOL_NAME,
  CODRIVER_VAULT_READ_TARGET_TOOL_NAME,
  CODRIVER_VAULT_SEARCH_TOOL_NAME,
  CODRIVER_VAULT_SEARCH_STRUCTURED_TOOL_NAME,
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  CODRIVER_VAULT_TOOL_NAMES,
  CODRIVER_VAULT_SERVER_ID,
  CODRIVER_VAULT_SERVER_NAME,
  createCodriverVaultMcpServer
};
