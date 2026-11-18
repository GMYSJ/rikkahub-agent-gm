package me.rerere.rikkahub.data.remote

import kotlinx.serialization.Serializable
import kotlin.uuid.Uuid
import me.rerere.ai.provider.CustomHeader
import me.rerere.ai.provider.ProviderSetting
import me.rerere.rikkahub.data.ai.mcp.McpCommonOptions
import me.rerere.rikkahub.data.ai.mcp.McpServerConfig

/**
 * 一台远程 DSH 电脑的连接配置。
 *
 * 内置设计的出发点（来自真机验证）：win-bridge 讲的是**标准协议**——
 * MCP Streamable HTTP（工具面）与 OpenAI chat/completions（模型面），
 * 而 RikkaHub **两侧都已有原生客户端**。因此这里不新增 Provider 子类，
 * 只把一个"电脑节点"翻译成两个已有的标准配置：
 *
 *   RemoteNode → McpServerConfig.StreamableHTTPServer  （工具）
 *   RemoteNode → ProviderSetting.OpenAI                （模型）
 *
 * 这样一次填写即可，且避开了新增 ProviderSetting 子类必须改 5+7 处
 * `when(provider)` 的高风险改动（本机无编译链，无法验证那些改动）。
 *
 * 安全约束：
 *  - token 只存本机 DataStore，绝不随工具/模型请求发往第三个节点；
 *  - URL 只接受 http/https，且必须是绝对地址（由设置页的守卫校验）；
 *  - name 必须纯英数（RikkaHub 的 MCP 工具名规则，见 ChatService.kt:1755-1770）。
 */
@Serializable
data class RemoteNode(
    val id: Uuid = Uuid.random(),
    /** 用户可见名称，如"我的游戏电脑"。 */
    val label: String = "DSH 电脑",
    /** 节点标识（纯 [A-Za-z0-9_]），用于 MCP server name 与工具名前缀。 */
    val slug: String = "windows_dsh",
    /** 桥的 host，如 192.168.1.3。 */
    val host: String = "",
    /** 桥的局域网监听端口，如 61420。 */
    val port: Int = 61420,
    /** Bearer token（与主入口 token 是两套独立凭据）。 */
    val token: String = "",
    val enabled: Boolean = true,
    /** 是否把该节点的模型加入可用 Provider 列表。 */
    val enableModels: Boolean = true,
    /** 是否把该节点的工具加入 MCP 工具列表。 */
    val enableTools: Boolean = true,
) {
    /** 桥的 HTTP 根地址（不含尾斜杠）。 */
    val baseUrl: String
        get() = "http://${host}:${port}/dsh-mobile-bridge"

    /** MCP 工具端点。 */
    val mcpUrl: String
        get() = "${baseUrl}/mcp"

    /** OpenAI 兼容模型端点（OpenAIProvider 会自动拼 /chat/completions）。 */
    val llmBaseUrl: String
        get() = "${baseUrl}/llm/v1"

    /** 配置是否完整可用。 */
    val isValid: Boolean
        get() = host.isNotBlank() && port in 1..65535 && token.length >= 16 && slug.matches(SLUG_REGEX)

    /** 脱敏输出，避免 token 进日志。 */
    override fun toString(): String =
        "RemoteNode(id=$id, label='$label', slug='$slug', host='$host', port=$port, " +
            "token=${if (token.isBlank()) "<empty>" else "***(${token.length})"}, " +
            "enabled=$enabled, enableModels=$enableModels, enableTools=$enableTools)"

    /**
     * 生成 MCP 客户端配置（工具面）。
     *
     * name 用 `mcp__<slug>` 形式保证纯英数；工具名最终会是
     * `mcp__dsh_<slug>__<tool>`，自动接入 RikkaHub 的审批与 hardline 规则。
     *
     * @return 配置，或 null（节点不完整/未启用工具）。
     */
    fun toMcpServerConfig(): McpServerConfig? {
        if (!enabled || !enableTools || !isValid) return null
        return McpServerConfig.StreamableHTTPServer(
            id = id,
            commonOptions = McpCommonOptions(
                enable = true,
                name = "dsh_${slug}",
                headers = listOf("Authorization" to "Bearer $token"),
            ),
            url = mcpUrl,
        )
    }

    /**
     * 生成 OpenAI 兼容 Provider 配置（模型面）。
     *
     * 不新增 ProviderSetting 子类，直接复用 OpenAI：
     *  - baseUrl 指向桥的 /llm/v1，OpenAIProvider 自己拼 /chat/completions
     *  - apiKey 放桥 token（桥用它做 Bearer 校验，不做厂商认证）
     *  - customHeaders 显式再带一份 Authorization，兼容不同 Provider 实现
     *
     * @return 配置，或 null（节点不完整/未启用模型）。
     */
    fun toOpenAIProvider(): ProviderSetting.OpenAI? {
        if (!enabled || !enableModels || !isValid) return null
        return ProviderSetting.OpenAI(
            id = id,
            enabled = true,
            name = "DSH: $label",
            apiKey = token,
            baseUrl = llmBaseUrl,
            chatCompletionsPath = "/chat/completions",
            customHeaders = listOf(CustomHeader("Authorization", "Bearer $token")),
            models = emptyList(),
        )
    }

    companion object {
        /** slug 规则与 RikkaHub MCP 工具名要求一致：纯英数下划线。 */
        val SLUG_REGEX = Regex("^[A-Za-z0-9_]+$")

        /** 从用户输入的任意字符串生成合法 slug。 */
        fun slugOf(value: String): String {
            val cleaned = value.trim().replace(Regex("[^A-Za-z0-9_]"), "_").trim('_')
            return if (cleaned.isEmpty()) "windows_dsh" else cleaned.take(32)
        }
    }
}

/** 把一组 RemoteNode 翻译成 MCP 配置（过滤掉无效/未启用的）。 */
fun List<RemoteNode>.toMcpConfigs(): List<McpServerConfig> =
    mapNotNull { it.toMcpServerConfig() }

/** 把一组 RemoteNode 翻译成 OpenAI Provider 配置。 */
fun List<RemoteNode>.toOpenAIProviders(): List<ProviderSetting.OpenAI> =
    mapNotNull { it.toOpenAIProvider() }
