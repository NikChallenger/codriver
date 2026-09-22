const { hashText, isPlainObject } = require("./McpToolUtils");
const {
  DEFAULT_MAX_MCP_TOOLS,
  MAX_MCP_TOOLS_SETTING,
  MIN_MCP_TOOLS
} = require("../settings/defaults");

function resolveSkillMcpRequirements(skills, configuredServers, options = {}) {
  const servers = Array.isArray(configuredServers) ? configuredServers.filter(Boolean) : [];
  const serverRequirements = [];
  const requirementsByServerId = new Map();
  const errors = [];

  for (const skill of Array.isArray(skills) ? skills : []) {
    const requirements = Array.isArray(skill?.requires?.mcp) ? skill.requires.mcp : [];
    for (const requirement of requirements) {
      const serverIdentity = String(requirement?.server || "").trim();
      const resolvedServer = resolveConfiguredMcpServer(servers, serverIdentity);
      if (!resolvedServer.ok) {
        errors.push(createDependencyError(resolvedServer.code, skill, {
          serverIdentity,
          matchCount: resolvedServer.matchCount
        }));
        continue;
      }

      const server = resolvedServer.server;
      if (options.isServerRuntimeBlocked?.(server) === true) {
        errors.push(createDependencyError("server-runtime-blocked", skill, {
          serverIdentity,
          serverId: server.id,
          serverName: server.name
        }));
        continue;
      }

      const discoveredTools = Array.isArray(server.tools)
        ? server.tools.filter((tool) => typeof tool?.name === "string" && tool.name.trim())
        : [];
      if (discoveredTools.length === 0) {
        errors.push(createDependencyError("tools-undiscovered", skill, {
          serverIdentity,
          serverId: server.id,
          serverName: server.name
        }));
        continue;
      }

      const requestedToolNames = Array.isArray(requirement?.tools) ? requirement.tools : null;
      const resolvedToolNames = [];
      let requirementFailed = false;
      if (requestedToolNames === null) {
        const visibleTools = discoveredTools.filter((tool) => (
          tool.enabled !== false && tool.available !== false
        ));
        if (visibleTools.length === 0) {
          errors.push(createDependencyError("server-tools-disabled", skill, {
            serverIdentity,
            serverId: server.id,
            serverName: server.name
          }));
          continue;
        }
        for (const tool of visibleTools) {
          if (visibleTools.filter((candidate) => candidate.name === tool.name).length > 1) {
            errors.push(createDependencyError("tool-ambiguous", skill, {
              serverIdentity,
              serverId: server.id,
              serverName: server.name,
              toolName: tool.name
            }));
            requirementFailed = true;
            break;
          }
          resolvedToolNames.push(tool.name);
        }
      } else {
        for (const toolName of requestedToolNames) {
          const matches = discoveredTools.filter((tool) => tool.name === toolName);
          if (matches.length === 0) {
            errors.push(createDependencyError("tool-missing", skill, {
              serverIdentity,
              serverId: server.id,
              serverName: server.name,
              toolName
            }));
            requirementFailed = true;
            continue;
          }
          if (matches.length > 1) {
            errors.push(createDependencyError("tool-ambiguous", skill, {
              serverIdentity,
              serverId: server.id,
              serverName: server.name,
              toolName
            }));
            requirementFailed = true;
            continue;
          }
          if (matches[0].available === false) {
            errors.push(createDependencyError("tool-unavailable", skill, {
              serverIdentity,
              serverId: server.id,
              serverName: server.name,
              toolName
            }));
            requirementFailed = true;
            continue;
          }
          resolvedToolNames.push(toolName);
        }
      }

      if (requirementFailed) {
        continue;
      }

      let target = requirementsByServerId.get(server.id);
      if (!target) {
        target = {
          serverId: server.id,
          serverName: server.name || server.id,
          allTools: requestedToolNames === null,
          toolNames: [],
          skillIds: [],
          skillNames: []
        };
        requirementsByServerId.set(server.id, target);
        serverRequirements.push(target);
      }
      if (requestedToolNames === null) {
        target.allTools = true;
      }
      appendUnique(target.skillIds, String(skill?.id || skill?.name || "").trim());
      appendUnique(target.skillNames, String(skill?.name || skill?.id || "").trim());
      for (const toolName of resolvedToolNames) {
        appendUnique(target.toolNames, toolName);
      }
    }
  }

  return {
    ok: errors.length === 0,
    serverRequirements,
    errors
  };
}

function resolveConfiguredMcpServer(configuredServers, identity) {
  const servers = Array.isArray(configuredServers) ? configuredServers : [];
  const exactIdMatches = servers.filter((server) => server?.id === identity);
  if (exactIdMatches.length === 1) {
    return {
      ok: true,
      server: exactIdMatches[0],
      matchedBy: "id"
    };
  }
  if (exactIdMatches.length > 1) {
    return {
      ok: false,
      code: "server-ambiguous",
      matchCount: exactIdMatches.length
    };
  }

  const exactNameMatches = servers.filter((server) => server?.name === identity);
  if (exactNameMatches.length === 1) {
    return {
      ok: true,
      server: exactNameMatches[0],
      matchedBy: "name"
    };
  }
  if (exactNameMatches.length > 1) {
    return {
      ok: false,
      code: "server-ambiguous",
      matchCount: exactNameMatches.length
    };
  }

  return {
    ok: false,
    code: "server-missing",
    matchCount: 0
  };
}

function buildRequestBoundMcpCatalog(options = {}) {
  const configuredServers = Array.isArray(options.configuredServers)
    ? options.configuredServers.filter(Boolean)
    : [];
  const firstPartyEntries = Array.isArray(options.firstPartyEntries)
    ? options.firstPartyEntries.filter((entry) => entry?.server && entry?.tool)
    : [];
  const manualServerIds = new Set(normalizeStringList(options.manualServerIds));
  const skillResolution = options.skillResolution && typeof options.skillResolution === "object"
    ? options.skillResolution
    : { serverRequirements: [] };
  const maxTools = normalizeMaxTools(options.maxTools);
  const entries = [];
  const entriesByKey = new Map();

  const addEntry = (server, tool, metadata = {}) => {
    const skillScoped = metadata.required === true;
    if (
      !server ||
      !tool ||
      (tool.enabled === false && !skillScoped) ||
      typeof tool.name !== "string" ||
      !tool.name.trim()
    ) {
      return;
    }
    const key = createMcpToolKey(server.id, tool.name);
    const existing = entriesByKey.get(key);
    if (existing) {
      existing.required = existing.required || metadata.required === true;
      existing.skillScoped = existing.skillScoped || skillScoped;
      existing.manual = existing.manual || metadata.manual === true;
      for (const skillId of metadata.skillIds ?? []) {
        appendUnique(existing.skillIds, skillId);
      }
      for (const skillName of metadata.skillNames ?? []) {
        appendUnique(existing.skillNames, skillName);
      }
      return;
    }

    const entry = createCatalogEntry(server, tool, metadata);
    entriesByKey.set(key, entry);
    entries.push(entry);
  };

  for (const requirement of skillResolution.serverRequirements ?? []) {
    const server = configuredServers.find((candidate) => candidate?.id === requirement.serverId);
    if (!server) {
      continue;
    }
    for (const toolName of requirement.toolNames ?? []) {
      const tool = server.tools?.find((candidate) => candidate?.name === toolName);
      addEntry(server, tool, {
        required: true,
        manual: manualServerIds.has(server.id) && server.enabled !== false,
        skillIds: requirement.skillIds,
        skillNames: requirement.skillNames
      });
    }
  }

  const requiredCount = entries.length;
  if (maxTools > 0 && requiredCount > maxTools) {
    return {
      ok: false,
      error: {
        code: "required-tools-over-limit",
        requiredCount,
        maxTools
      },
      entries: [],
      requiredCount,
      omittedCount: 0,
      totalCandidateCount: requiredCount,
      maxTools,
      manualServerIds: [...manualServerIds],
      fingerprint: ""
    };
  }

  for (const entry of firstPartyEntries) {
    addEntry(entry.server, entry.tool);
  }

  for (const server of configuredServers) {
    if (
      !manualServerIds.has(server.id) ||
      server.enabled === false ||
      options.isServerRuntimeBlocked?.(server) === true
    ) {
      continue;
    }
    for (const tool of Array.isArray(server.tools) ? server.tools : []) {
      addEntry(server, tool, { manual: true });
    }
  }

  const totalCandidateCount = entries.length;
  const selectedEntries = maxTools === 0 ? entries : entries.slice(0, maxTools);
  const catalog = {
    ok: true,
    entries: selectedEntries,
    requiredCount,
    omittedCount: Math.max(0, totalCandidateCount - selectedEntries.length),
    totalCandidateCount,
    maxTools,
    manualServerIds: [...manualServerIds],
    fingerprint: ""
  };
  catalog.fingerprint = createMcpCatalogFingerprint(catalog);
  return catalog;
}

function createCatalogEntry(server, tool, metadata = {}) {
  return {
    key: createMcpToolKey(server.id, tool.name),
    server: {
      id: String(server.id || ""),
      name: String(server.name || server.id || ""),
      transport: String(server.transport || "")
    },
    tool: {
      name: String(tool.name || ""),
      title: typeof tool.title === "string" ? tool.title : "",
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: cloneJsonObject(tool.inputSchema),
      outputSchema: cloneJsonObject(tool.outputSchema),
      annotations: cloneJsonObject(tool.annotations),
      enabled: metadata.required === true || tool.enabled !== false,
      allowAutomaticExecution: tool.allowAutomaticExecution === true,
      allowAutomaticProposalApplication: tool.allowAutomaticProposalApplication === true,
      automaticPermissionConfigurable: tool.automaticPermissionConfigurable === true,
      automaticPermissionReadonly: tool.automaticPermissionReadonly === true,
      writesVault: tool.writesVault === true
    },
    required: metadata.required === true,
    skillScoped: metadata.required === true,
    manual: metadata.manual === true,
    skillIds: normalizeStringList(metadata.skillIds),
    skillNames: normalizeStringList(metadata.skillNames)
  };
}

function createMcpCatalogFingerprint(catalog) {
  const value = {
    maxTools: catalog?.maxTools ?? 0,
    requiredCount: catalog?.requiredCount ?? 0,
    omittedCount: catalog?.omittedCount ?? 0,
    totalCandidateCount: catalog?.totalCandidateCount ?? 0,
    manualServerIds: normalizeStringList(catalog?.manualServerIds),
    entries: (catalog?.entries ?? []).map((entry) => ({
      key: entry.key,
      server: entry.server,
      tool: {
        name: entry.tool?.name,
        title: entry.tool?.title,
        description: entry.tool?.description,
        inputSchema: entry.tool?.inputSchema,
        outputSchema: entry.tool?.outputSchema,
        annotations: entry.tool?.annotations,
        enabled: entry.tool?.enabled !== false,
        writesVault: entry.tool?.writesVault === true
      },
      required: entry.required,
      skillScoped: entry.skillScoped,
      manual: entry.manual,
      skillIds: entry.skillIds
    }))
  };
  return hashText(stableJsonStringify(value));
}

function catalogHasMcpTool(catalog, serverId, toolName) {
  const key = createMcpToolKey(serverId, toolName);
  return Array.isArray(catalog?.entries) && catalog.entries.some((entry) => entry?.key === key);
}

function createMcpToolKey(serverId, toolName) {
  return `${String(serverId || "").trim()}\u0000${String(toolName || "").trim()}`;
}

function createDependencyError(code, skill, details = {}) {
  return {
    code,
    skillId: String(skill?.id || skill?.name || "").trim(),
    skillName: String(skill?.name || skill?.id || "").trim(),
    serverIdentity: String(details.serverIdentity || "").trim(),
    serverId: String(details.serverId || "").trim(),
    serverName: String(details.serverName || "").trim(),
    toolName: String(details.toolName || "").trim(),
    matchCount: Number.isInteger(details.matchCount) ? details.matchCount : 0
  };
}

function normalizeMaxTools(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return DEFAULT_MAX_MCP_TOOLS;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_MAX_MCP_TOOLS;
  }
  return Math.min(MAX_MCP_TOOLS_SETTING, Math.max(MIN_MCP_TOOLS, Math.trunc(number)));
}

function normalizeStringList(value) {
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    appendUnique(result, String(item || "").trim());
  }
  return result;
}

function appendUnique(items, value) {
  if (value && !items.includes(value)) {
    items.push(value);
  }
}

function cloneJsonObject(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  buildRequestBoundMcpCatalog,
  catalogHasMcpTool,
  createMcpCatalogFingerprint,
  createMcpToolKey,
  normalizeMaxTools,
  resolveConfiguredMcpServer,
  resolveSkillMcpRequirements
};
