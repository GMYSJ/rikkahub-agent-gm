package me.rerere.rikkahub.data.remote

import me.rerere.ai.provider.ProviderSetting
import me.rerere.rikkahub.data.ai.mcp.McpServerConfig
import me.rerere.rikkahub.data.datastore.Settings
import me.rerere.rikkahub.data.model.Assistant

/**
 * 把内置 RemoteNode 配置同步成 RikkaHub 已有的标准配置。
 *
 * 设计原则（来自真机验证与源码审计）：
 *  1. **不新增 ProviderSetting 子类**——那要改 5 处会编译失败的 `when`
 *     和 ProviderConfigure 的 7 处 `when`。本机无编译链，风险不可控。
 *  2. **不侵入 ChatService 的工具装配**——MCP/Provider 原生链路已验证可用。
 *  3. 生成的 MCP server 默认**不自动勾选给 assistant**——`McpManager.kt:110`
 *     要求 `id in assistant.mcpServers`，这是产品故意的安全门，保留它。
 *
 * 幂等性：按 id 覆盖，不重复追加。同一个节点重复同步不会产生两份配置。
 */
object RemoteNodeSync {

    /**
     * 同步结果，用于设置页展示。
     */
    data class Result(
        val mcpAdded: Int,
        val mcpRemoved: Int,
        val providerAdded: Int,
        val providerRemoved: Int,
        val assistantMcpAdded: Int,
    )

    /**
     * 把 settings.remoteNodes 翻译成新的 Settings。
     *
     * @param settings 当前设置。
     * @param assistantIds 需要自动勾选该 MCP server 的 assistant id 列表。
     *   传空列表表示只添加 server，不自动勾选（用户需去 Assistant → MCP 手动开）。
     * @param selected 每个节点探测选中的地址（nodeId → endpoint）。
     *   传入后用它生成标准配置；不传则回退到节点自己的第一条地址。
     *   这样"当前在哪就用哪条"，换网络时重新探测再 sync 即可。
     * @return 新 Settings，以及同步统计。
     */
    fun sync(
        settings: Settings,
        assistantIds: Collection<kotlin.uuid.Uuid> = emptyList(),
        selected: Map<kotlin.uuid.Uuid, RemoteEndpoint> = emptyMap(),
    ): Pair<Settings, Result> {
        val nodes = settings.remoteNodes.filter { it.enabled && it.isValid }
        val nodeIds = nodes.map { it.id }.toSet()

        // ---- MCP servers：保留所有非本特征来源的项，按 id 覆盖节点项 ----
        val managedPrefix = "dsh_"
        val isManaged = { server: McpServerConfig ->
            server.commonOptions.name.startsWith(managedPrefix)
        }
        val keptMcp = settings.mcpServers.filterNot { isManaged(it) || it.id in nodeIds }
        val newMcp = nodes.mapNotNull { node -> node.toMcpServerConfig(selected[node.id]) }
        val mergedMcp = keptMcp + newMcp

        // ---- Providers：同样按 id 覆盖，名字以 "DSH: " 开头视为托管 ----
        val isManagedProvider = { p: ProviderSetting ->
            p.name.startsWith("DSH: ") || p.id in nodeIds
        }
        val keptProviders = settings.providers.filterNot(isManagedProvider)
        val newProviders = nodes.mapNotNull { node -> node.toOpenAIProvider(selected[node.id]) }
        val mergedProviders = keptProviders + newProviders

        // ---- assistants：按需自动勾选 MCP server ----
        val newServerIds = newMcp.map { it.id }.toSet()
        var assistantMcpAdded = 0
        val updatedAssistants = settings.assistants.map { assistant ->
            if (assistant.id !in assistantIds) return@map assistant
            val before = assistant.mcpServers.size
            val merged = assistant.mcpServers + newServerIds
            if (merged.size != before) assistantMcpAdded += merged.size - before
            assistant.copy(mcpServers = merged)
        }

        val result = Result(
            mcpAdded = newMcp.size,
            mcpRemoved = settings.mcpServers.count { isManaged(it) || it.id in nodeIds } - newMcp.size,
            providerAdded = newProviders.size,
            providerRemoved = settings.providers.count(isManagedProvider) - newProviders.size,
            assistantMcpAdded = assistantMcpAdded,
        )

        return settings.copy(
            mcpServers = mergedMcp,
            providers = mergedProviders,
            assistants = updatedAssistants,
        ) to result
    }

    /**
     * 移除某个节点生成的所有标准配置（用于删除节点时清理）。
     *
     * @param settings 当前设置。
     * @param nodeId 要移除的节点 id。
     * @return 清理后的 Settings。
     */
    fun removeNode(settings: Settings, nodeId: kotlin.uuid.Uuid): Settings {
        val nodes = settings.remoteNodes.filter { it.id != nodeId }
        val mcpIds = settings.mcpServers
            .filter { it.id == nodeId || it.commonOptions.name == "dsh_${settings.remoteNodes.firstOrNull { it.id == nodeId }?.slug ?: ""}" }
            .map { it.id }
            .toSet()
        return settings.copy(
            remoteNodes = nodes,
            mcpServers = settings.mcpServers.filterNot { it.id in mcpIds },
            providers = settings.providers.filterNot { it.id == nodeId || it.name.startsWith("DSH: ") && it.id == nodeId },
            assistants = settings.assistants.map { assistant ->
                assistant.copy(mcpServers = assistant.mcpServers - mcpIds)
            },
        )
    }
}
