package me.rerere.rikkahub.ui.pages.setting

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.uuid.Uuid
import me.rerere.rikkahub.data.datastore.SettingsStore
import me.rerere.rikkahub.data.remote.RemoteEndpoint
import me.rerere.rikkahub.data.remote.RemoteNode
import me.rerere.rikkahub.data.remote.RemoteNodeProbe
import me.rerere.rikkahub.data.remote.RemoteNodeSync
import me.rerere.rikkahub.ui.components.nav.BackButton
import me.rerere.rikkahub.ui.context.LocalSettings
import me.rerere.rikkahub.ui.context.LocalToaster
import okhttp3.OkHttpClient
import org.koin.compose.koinInject

/**
 * 远程 DSH 节点设置页（内置入口）。
 *
 * 核心：**一个节点支持任意多条可达地址**（家里 WLAN、Tailscale、EasyTier、
 * cpolar、或将来任何通道），保存时并发探测、自动选当前最快的一条，
 * 手机在网络间移动时无需手动改地址。
 *
 * 说明：
 *  1. 文案用字面量，未走 strings.xml —— 内部功能，避免改 7 个 locale 文件
 *     引入无法本机验证的编译风险。
 *  2. MCP server 添加后不自动勾选给 assistant（产品原有安全门）。
 *  3. token 以密码框输入，只存本机 DataStore。
 */
@Composable
fun SettingRemoteNodePage() {
    val settingsStore: SettingsStore = koinInject()
    val okHttpClient: OkHttpClient = koinInject()
    val settings = LocalSettings.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    val probe = remember { RemoteNodeProbe(okHttpClient) }

    var label by remember { mutableStateOf("DSH 电脑") }
    var slug by remember { mutableStateOf("windows_dsh") }
    var enableTools by remember { mutableStateOf(true) }
    var enableModels by remember { mutableStateOf(true) }
    // 可变地址列表（任意条）
    val endpoints = remember { mutableStateListOf<RemoteEndpoint>() }
    // 新增地址的输入框
    var newLabel by remember { mutableStateOf("") }
    var newUrl by remember { mutableStateOf("") }
    var newToken by remember { mutableStateOf("") }
    var newPriority by remember { mutableStateOf("100") }
    // 探测结果展示
    var probeText by remember { mutableStateOf("") }
    var probing by remember { mutableStateOf(false) }

    fun addEndpoint() {
        val url = newUrl.trim().trimEnd('/')
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            toaster.show("地址必须以 http:// 或 https:// 开头")
            return
        }
        if (newToken.trim().length < 16) {
            toaster.show("Token 至少 16 位")
            return
        }
        val prio = newPriority.toIntOrNull() ?: 100
        endpoints.add(
            RemoteEndpoint(
                label = newLabel.ifBlank { "地址 ${endpoints.size + 1}" },
                baseUrl = url,
                token = newToken.trim(),
                priority = prio,
            )
        )
        newLabel = ""; newUrl = ""; newToken = ""
        toaster.show("已添加地址（共 ${endpoints.size} 条）")
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("远程 DSH 节点") },
                navigationIcon = { BackButton() },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp),
        ) {
            item {
                Text(
                    "一个节点可配置多条地址（家里、Tailscale、EasyTier、cpolar…）。",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "保存时自动探测，选当前最快的一条；换网络后点「重新探测」即可，不用改地址。",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
            }

            item {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("节点名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = slug,
                    onValueChange = { slug = it },
                    label = { Text("节点标识（字母数字下划线）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = enableTools, onCheckedChange = { enableTools = it })
                    Text("启用电脑工具")
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = enableModels, onCheckedChange = { enableModels = it })
                    Text("启用电脑模型")
                }
                Spacer(Modifier.height(12.dp))
            }

            item { Text("可达地址（${endpoints.size} 条）", style = MaterialTheme.typography.titleMedium) }
            items(endpoints, key = { it.id }) { ep ->
                Card(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text("${ep.label}  (优先级 ${ep.priority})", style = MaterialTheme.typography.titleSmall)
                        Text(ep.baseUrl, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { endpoints.remove(ep) }) { Text("移除") }
                    }
                }
            }

            item {
                Spacer(Modifier.height(8.dp))
                Text("添加地址", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = newLabel,
                    onValueChange = { newLabel = it },
                    label = { Text("名称（如：家里 / 外出Tailscale）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newUrl,
                    onValueChange = { newUrl = it },
                    label = { Text("完整地址（含端口）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newToken,
                    onValueChange = { newToken = it },
                    label = { Text("该地址的 Token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newPriority,
                    onValueChange = { newPriority = it },
                    label = { Text("优先级（数字小的优先）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(onClick = { addEndpoint() }, modifier = Modifier.fillMaxWidth()) {
                    Text("添加这条地址")
                }
                Spacer(Modifier.height(12.dp))
            }

            item {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !probing,
                    onClick = {
                        if (endpoints.isEmpty()) {
                            toaster.show("请先添加至少一条地址")
                            return@Button
                        }
                        val node = RemoteNode(
                            id = Uuid.random(),
                            label = label.ifBlank { "DSH 电脑" },
                            slug = RemoteNode.slugOf(slug),
                            endpoints = endpoints.toList(),
                            enableTools = enableTools,
                            enableModels = enableModels,
                        )
                        if (!node.isValid) {
                            toaster.show("配置无效：检查地址与 Token")
                            return@Button
                        }
                        probing = true
                        scope.launch {
                            // 并发探测所有地址，选最快的一条
                            val results = probe.probe(node)
                            val best = results.firstOrNull { it.reachable }?.endpoint
                            probeText = results.joinToString("\n") { r ->
                                "${if (r.reachable) "✓" else "✗"} ${r.endpoint.label}  ${r.latencyMs}ms" +
                                    (r.error?.let { "  ($it)" } ?: "")
                            }
                            if (best == null) {
                                toaster.show("所有地址都不可达，请检查网络或 VPN")
                                probing = false
                                return@launch
                            }
                            // 用探测选中的地址生成标准配置并保存（保留节点 id 稳定）
                            val stableNode = node.copy(id = Uuid.random())
                            val selected = mapOf(stableNode.id to best)
                            settingsStore.update { current ->
                                val withNode = current.copy(
                                    remoteNodes = current.remoteNodes.filter { it.slug != stableNode.slug } + stableNode,
                                )
                                RemoteNodeSync.sync(withNode, selected = selected).first
                            }
                            toaster.show("已连接：${best.label}，请到 Assistant → MCP 勾选 dsh_${stableNode.slug}")
                            probing = false
                        }
                    },
                ) { Text(if (probing) "探测中…" else "探测并保存") }
                Spacer(Modifier.height(8.dp))
                if (probeText.isNotBlank()) {
                    Text("探测结果：", style = MaterialTheme.typography.titleSmall)
                    Text(probeText, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }
            }

            item {
                Text("已保存节点：${settings.remoteNodes.size} 个", style = MaterialTheme.typography.titleMedium)
                val currentProbe = remember { RemoteNodeProbe(okHttpClient) }
                settings.remoteNodes.forEach { node ->
                    Card(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text(node.label, style = MaterialTheme.typography.titleSmall)
                            Text("地址 ${node.effectiveEndpoints.size} 条 · slug=${node.slug}")
                            Row {
                                TextButton(
                                    onClick = {
                                        scope.launch {
                                            val best = currentProbe.best(node)
                                            if (best == null) toaster.show("当前所有地址都不可达")
                                            else {
                                                settingsStore.update { current ->
                                                    RemoteNodeSync.sync(
                                                        current,
                                                        selected = mapOf(node.id to best),
                                                    ).first
                                                }
                                                toaster.show("已切换到：${best.label}")
                                            }
                                        }
                                    },
                                ) { Text("重新探测") }
                                TextButton(
                                    onClick = {
                                        scope.launch {
                                            settingsStore.update { current ->
                                                RemoteNodeSync.removeNode(
                                                    current.copy(remoteNodes = current.remoteNodes.filter { it.id != node.id }),
                                                    node.id,
                                                )
                                            }
                                            toaster.show("已删除")
                                        }
                                    },
                                ) { Text("删除") }
                            }
                        }
                    }
                }
            }
        }
    }
}
