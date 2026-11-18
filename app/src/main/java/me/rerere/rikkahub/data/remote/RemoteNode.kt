package me.rerere.rikkahub.data.remote

import kotlinx.serialization.Serializable
import kotlin.uuid.Uuid
import me.rerere.ai.provider.CustomHeader
import me.rerere.ai.provider.ProviderSetting
import me.rerere.rikkahub.data.ai.mcp.McpCommonOptions
import me.rerere.rikkahub.data.ai.mcp.McpServerConfig

/**
 * 一个可达地址（LAN / Tailscale / EasyTier / cpolar / 任意自定义）。
 *
 * 设计要点：**不写死地址种类、不限制条数**。
 * 用户想加几条就加几条，运行时按 [priority] 顺序探测，第一条通的获胜。
 */
@Serializable
data class RemoteEndpoint(
    val id: Uuid = Uuid.random(),
    /** 用户可见名称，如"家里 WLAN" / "外出 Tailscale"。 */
    val label: String = "",
    /** 协议+主机，如 http://192.168.1.3:61420 或 https://abc.cpolar.cn。 */
    val baseUrl: String = "",
    /** 该地址的独立 token（不同通道建议不同凭据）。 */
    val token: String = "",
    /** 探测优先级，小的优先。 */
    val priority: Int = 100,
    /** 是否启用这条地址。 */
    val enabled: Boolean = true,
) {
    /** 规范化后的根地址（去尾斜杠）。 */
    val normalizedBaseUrl: String
        get() = baseUrl.trim().trimEnd('/')

    val isValid: Boolean
        get() = normalizedBaseUrl.let {
            (it.startsWith("http://") || it.startsWith("https://")) && it.length > 12 && token.length >= 16
        }

    val mcpUrl: String get() = "${normalizedBaseUrl}/dsh-mobile-bridge/mcp"
    val llmBaseUrl: String get() = "${normalizedBaseUrl}/dsh-mobile-bridge/llm/v1"
    val healthUrl: String get() = "${normalizedBaseUrl}/dsh-mobile-bridge/health"

    override fun toString(): String =
        "RemoteEndpoint(label='$label', baseUrl='$normalizedBaseUrl', " +
            "token=${if (token.isBlank()) "<empty>" else "***(${token.length})"}, " +
            "priority=$priority, enabled=$enabled)"
}

/**
 * 一台远程 DSH 电脑，**可以有多条可达地址**。
 *
 * 内置设计的出发点（真机验证过）：桥讲的是标准协议——
 * MCP Streamable HTTP（工具）与 OpenAI chat/completions（模型），
 * RikkaHub 两侧都有原生客户端。所以这里不新增 Provider 子类，
 * 只把节点翻译成两个标准配置，避免新增 ProviderSetting 必须改的 5+7 处 `when`。
 *
 * **多地址如何工作**：
 *  - 数据层保留任意多条 [RemoteEndpoint]（LAN / 隧道 / 未来任何通道）
 *  - 设置页/同步时按 priority 探测，选第一条当前可达的
 *  - 因为 RikkaHub 的 MCP/Provider 只能存一个 URL，最终写入的是"当前最佳"那一条
 *  - 以后换网络，重新探测即可，不需要改结构
 *
 * 兼容：保留旧的 [host]/[port]/[token] 单地址字段，老配置能干净解码。
 * 新代码优先用 [endpoints]，为空时回退到旧字段合成的 single endpoint。
 */
@Serializable
data class RemoteNode(
    val id: Uuid = Uuid.random(),
    /** 用户可见名称，如"我的游戏电脑"。 */
    val label: String = "DSH 电脑",
    /** 节点标识（纯 [A-Za-z0-9_]），用于 MCP server name 与工具名前缀。 */
    val slug: String = "windows_dsh",
    /** 多条可达地址（新结构）。 */
    val endpoints: List<RemoteEndpoint> = emptyList(),
    /** ---- 以下为旧单地址字段，保留兼容 ---- */
    val host: String = "",
    val port: Int = 61420,
    val token: String = "",
    val enabled: Boolean = true,
    val enableModels: Boolean = true,
    val enableTools: Boolean = true,
) {
    /**
     * 当前生效的地址列表：新结构优先，为空则用旧字段合成一条。
     * 这样老版本保存的配置升级后依然可用。
     */
    val effectiveEndpoints: List<RemoteEndpoint>
        get() = if (endpoints.isNotEmpty()) {
            endpoints.filter { it.enabled }
        } else if (host.isNotBlank() && token.length >= 16) {
            listOf(
                RemoteEndpoint(
                    label = "默认",
                    baseUrl = "http://${host.trim()}:${port}",
                    token = token,
                    priority = 100,
                )
            )
        } else emptyList()

    /** 按优先级排序的可用地址（探测顺序）。 */
    val sortedEndpoints: List<RemoteEndpoint>
        get() = effectiveEndpoints.filter { it.isValid }.sortedBy { it.priority }

    /** 是否至少有一条有效地址。 */
    val isValid: Boolean get() = sortedEndpoints.isNotEmpty()

    /** 脱敏输出，避免 token 进日志。 */
    override fun toString(): String =
        "RemoteNode(id=$id, label='$label', slug='$slug', endpoints=${endpoints.size}, " +
            "enabled=$enabled, enableModels=$enableModels, enableTools=$enableTools)"

    /**
     * 用指定地址生成 MCP 客户端配置（工具面）。
     *
     * @param endpoint 探测选中的地址；不传则用第一条。
     */
    fun toMcpServerConfig(endpoint: RemoteEndpoint? = null): McpServerConfig? {
        if (!enabled || !enableTools) return null
        val ep = endpoint ?: sortedEndpoints.firstOrNull() ?: return null
        return McpServerConfig.StreamableHTTPServer(
            id = id,
            commonOptions = McpCommonOptions(
                enable = true,
                name = "dsh_${slug}",
                headers = listOf("Authorization" to "Bearer ${ep.token}"),
            ),
            url = ep.mcpUrl,
        )
    }

    /**
     * 用指定地址生成 OpenAI 兼容 Provider 配置（模型面）。
     */
    fun toOpenAIProvider(endpoint: RemoteEndpoint? = null): ProviderSetting.OpenAI? {
        if (!enabled || !enableModels) return null
        val ep = endpoint ?: sortedEndpoints.firstOrNull() ?: return null
        return ProviderSetting.OpenAI(
            id = id,
            enabled = true,
            name = "DSH: $label",
            apiKey = ep.token,
            baseUrl = ep.llmBaseUrl,
            chatCompletionsPath = "/chat/completions",
            customHeaders = listOf(CustomHeader("Authorization", "Bearer ${ep.token}")),
            models = emptyList(),
        )
    }

    /**
     * 生成"探测用"的轻量配置：把一个 endpoint 转成临时节点，
     * 便于设置页并发试每条地址。
     */
    fun withEndpoint(ep: RemoteEndpoint): RemoteNode = copy(
        endpoints = listOf(ep.copy()),
        host = "",
        token = "",
    )

    companion object {
        val SLUG_REGEX = Regex("^[A-Za-z0-9_]+$")

        fun slugOf(value: String): String {
            val cleaned = value.trim().replace(Regex("[^A-Za-z0-9_]"), "_").trim('_')
            return if (cleaned.isEmpty()) "windows_dsh" else cleaned.take(32)
        }

        /** 从完整 URL 推导 host/port（用于旧字段兼容显示）。 */
        fun hostPortOf(baseUrl: String): Pair<String, Int> {
            return try {
                val uri = java.net.URI(baseUrl.trim().trimEnd('/'))
                val host = uri.host ?: ""
                val port = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
                host to port
            } catch { "" to 0 }
        }
    }
}

/** 把一组节点翻译成 MCP 配置（各取当前第一条地址）。 */
fun List<RemoteNode>.toMcpConfigs(): List<McpServerConfig> =
    mapNotNull { it.toMcpServerConfig() }

/** 把一组节点翻译成 OpenAI Provider 配置。 */
fun List<RemoteNode>.toOpenAIProviders(): List<ProviderSetting.OpenAI> =
    mapNotNull { it.toOpenAIProvider() }
