package me.rerere.rikkahub.data.remote

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import me.rerere.rikkahub.data.datastore.SettingsStore
import kotlin.uuid.Uuid

/**
 * 远程 DSH 节点「网络变化自动切换」。
 *
 * 解决的问题：用户有三条通道（家里 WiFi / Tailscale / EasyTier），
 * 网络一换就得手动去设置页点"重新探测"。这个管理器在后台监听网络变化，
 * 自动探测并为每个节点选出当前最佳地址，然后覆盖 MCP / Provider 配置。
 *
 * 安全原则：
 *  - 只有配置里存在 remoteNodes 时才工作（零节点零开销）
 *  - 某节点所有地址都探测失败 → **不改动**它（避免把能用的配成坏的）
 *  - 探测结果不变 → 不写 settings（避免无谓的磁盘写与 UI 抖动）
 *  - 防抖 3 秒：网络切换常有一连串回调，只处理最后一次
 *
 * 生命周期：跟随 Application（AppScope），不需要 Foreground Service ——
 * NetworkCallback 是系统回调，进程活着就能收到；进程死了本来也不用切。
 */
class RemoteNodeAutoSwitch(
    private val context: Context,
    private val settingsStore: SettingsStore,
    private val probe: RemoteNodeProbe,
    private val scope: CoroutineScope,
) {
    companion object {
        private const val TAG = "RemoteNodeAutoSwitch"
        private const val DEBOUNCE_MS = 3_000L
    }

    private var callback: ConnectivityManager.NetworkCallback? = null
    private var pendingJob: Job? = null
    /** 每个节点上次选中的地址，用于判断"是否真的变了"。 */
    private val lastSelected = mutableMapOf<Uuid, String>()

    /**
     * 开始监听网络变化。可重复调用（幂等）。
     */
    fun start() {
        if (callback != null) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = scheduleProbe("available")
            override fun onLost(network: Network) = scheduleProbe("lost")
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                // 只在真正有网络时触发，过滤掉能力变化的噪声
                if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                    scheduleProbe("capabilities")
                }
            }
        }
        callback = cb

        try {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.registerDefaultNetworkCallback(cb)
            Log.d(TAG, "started: listening for network changes")
        } catch (e: Exception) {
            Log.w(TAG, "registerDefaultNetworkCallback failed", e)
            callback = null
        }

        // 启动时先探测一次（进程重启后也要保证配置是当前网络下最优的）
        scope.launch(Dispatchers.IO) { doProbe("startup") }
    }

    /** 防抖：取消上一个待执行的探测，重新排一个。 */
    private fun scheduleProbe(reason: String) {
        pendingJob?.cancel()
        pendingJob = scope.launch(Dispatchers.IO) {
            delay(DEBOUNCE_MS)
            doProbe(reason)
        }
    }

    /**
     * 真正执行探测 + 覆盖配置。
     */
    private suspend fun doProbe(reason: String) {
        val settings = settingsStore.settingsFlow.first()
        val nodes = settings.remoteNodes.filter { it.enabled }
        if (nodes.isEmpty()) return  // 零节点：完全不工作

        // 并发探测所有节点
        val bestMap = probe.bestForAll(nodes)
        if (bestMap.isEmpty()) {
            Log.d(TAG, "probe($reason): no reachable endpoint, keep current config")
            return  // 全部失败：不改动
        }

        // 判断是否有变化：只有最佳地址 URL 真的变了才写 settings
        var changed = false
        val newSelection = mutableMapOf<Uuid, String>()
        for ((nodeId, ep) in bestMap) {
            val url = ep.normalizedBaseUrl
            newSelection[nodeId] = url
            if (lastSelected[nodeId] != url) changed = true
        }
        // 有节点从"有地址"变"全失败"也要记为变化（但上面 bestMap 为空已 return；
        // 这里处理"部分节点失败"：失败的节点保留 lastSelected，不动它的配置）
        if (!changed) {
            Log.d(TAG, "probe($reason): best endpoints unchanged, skip update")
            return
        }

        try {
            settingsStore.update { current ->
                RemoteNodeSync.sync(current, selected = bestMap).first
            }
            lastSelected.clear()
            lastSelected.putAll(newSelection)
            Log.i(TAG, "probe($reason): switched to ${bestMap.values.joinToString { it.label }}")
        } catch (e: Exception) {
            Log.w(TAG, "probe($reason): update settings failed", e)
        }
    }

    /**
     * 停止监听（Application 退出时；通常不需要）。
     */
    fun stop() {
        pendingJob?.cancel()
        callback?.let { cb ->
            try {
                context.getSystemService(ConnectivityManager::class.java)
                    ?.unregisterNetworkCallback(cb)
            } catch (e: Exception) {
                Log.w(TAG, "unregister failed", e)
            }
        }
        callback = null
    }
}
