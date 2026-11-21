package me.rerere.rikkahub.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import kotlin.system.measureTimeMillis

/**
 * 远程节点地址探测器。
 *
 * 目的：用户已经在外面时，不必手动把节点 IP 从"家里 WLAN"改成"Tailscale"。
 * 探测所有已配置地址，按**可达性 + 延迟**排序，选最优的一条用于生成
 * MCP / Provider 标准配置。
 *
 * 设计：
 *  - 并发探测，不串行等待（N 条地址总耗时 ≈ 最慢那条，不是 N 倍）
 *  - 短超时（默认 2 秒），不让探测本身拖慢设置页
 *  - `/health` 不需要 token（bridge 的设计），所以探测不带凭据
 *  - 结果按 (可达?, 延迟) 排序；全不可达时返回空列表，调用方保留原配置
 */
class RemoteNodeProbe(
    private val client: OkHttpClient,
    private val timeoutMs: Long = 2_000L,
) {
    /** 一条地址的探测结果。 */
    data class Result(
        val endpoint: RemoteEndpoint,
        val reachable: Boolean,
        val latencyMs: Long,
        val error: String? = null,
    )

    /**
     * 并发探测一个节点的所有地址。
     *
     * @return 按"可达优先、延迟升序"排序的结果；第一条即当前最佳地址。
     */
    suspend fun probe(node: RemoteNode): List<Result> = withContext(Dispatchers.IO) {
        val endpoints = node.sortedEndpoints
        if (endpoints.isEmpty()) return@withContext emptyList()

        // 每条地址一个探测请求，超时单独控制
        val probeClient = client.newBuilder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .build()

        val results = coroutineScope {
            endpoints.map { ep ->
                async {
                    var failure: String? = null
                    val latency = measureTimeMillis {
                        try {
                            val req = Request.Builder()
                                .url(ep.healthUrl)
                                .get()
                                .build()
                            probeClient.newCall(req).execute().use { resp ->
                                if (!resp.isSuccessful) failure = "HTTP ${resp.code}"
                            }
                        } catch (e: Exception) {
                            failure = e.message ?: e.javaClass.simpleName
                        }
                    }
                    if (failure == null) Result(ep, true, latency)
                    else Result(ep, false, latency, failure)
                }
            }.awaitAll()
        }

        results.sortedWith(compareByDescending<Result> { it.reachable }.thenBy { it.latencyMs })
    }

    /**
     * 探测并返回当前最佳地址（可达且延迟最低）。
     *
     * @return 最佳地址，或 null（全部不可达）。
     */
    suspend fun best(node: RemoteNode): RemoteEndpoint? = probe(node).firstOrNull { it.reachable }?.endpoint

    /**
     * 探测一组节点，为每个节点选出最佳地址。
     *
     * @return 节点 id → 最佳地址（不可达的节点不在结果里）。
     */
    suspend fun bestForAll(nodes: List<RemoteNode>): Map<kotlin.uuid.Uuid, RemoteEndpoint> =
        coroutineScope {
            nodes.map { node -> async { best(node)?.let { node.id to it } } }
                .awaitAll()
                .filterNotNull()
                .toMap()
        }
}
