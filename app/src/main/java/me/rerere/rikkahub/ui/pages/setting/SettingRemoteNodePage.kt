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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import me.rerere.rikkahub.data.datastore.SettingsStore
import me.rerere.rikkahub.data.remote.RemoteNode
import me.rerere.rikkahub.data.remote.RemoteNodeSync
import me.rerere.rikkahub.ui.components.nav.BackButton
import me.rerere.rikkahub.ui.context.LocalSettings
import me.rerere.rikkahub.ui.context.LocalToaster
import org.koin.compose.koinInject

/**
 * 远程 DSH 节点设置页（内置入口）。
 *
 * 填写一次即可自动生成：
 *  - MCP 工具端点（StreamableHTTP，指向桥的 /mcp）
 *  - OpenAI 兼容模型 Provider（指向桥的 /llm/v1）
 *
 * 说明：
 *  1. 文案暂用字面量，未走 strings.xml —— 这是内部功能，避免为此改 7 个 locale 文件
 *     引入无法在本机验证的编译风险。后续可补国际化。
 *  2. MCP server 添加后**不会自动勾选给 assistant**（那是产品故意的安全门）。
 *     用户仍需到 Assistant → MCP 勾选 "dsh_<slug>" 才会出现工具。
 *  3. 节点 token 以密码框输入，只存本机 DataStore。
 */
@Composable
fun SettingRemoteNodePage() {
    val settingsStore: SettingsStore = koinInject()
    val settings = LocalSettings.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()

    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("61420") }
    var token by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("DSH 电脑") }
    var enableTools by remember { mutableStateOf(true) }
    var enableModels by remember { mutableStateOf(true) }

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
                    "填写电脑上运行 dsh-mobile-bridge 的地址。保存后会同时配置好工具与模型入口。",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
            }

            item {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = host,
                    onValueChange = { host = it },
                    label = { Text("电脑 IP（如 192.168.1.3）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = port,
                    onValueChange = { port = it },
                    label = { Text("端口（默认 61420）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("LAN Token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
            }

            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = enableTools, onCheckedChange = { enableTools = it })
                    Text("启用电脑工具（MCP）")
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = enableModels, onCheckedChange = { enableModels = it })
                    Text("启用电脑模型（OpenAI 兼容）")
                }
                Spacer(Modifier.height(8.dp))
            }

            item {
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        val portNum = port.toIntOrNull()
                        if (host.isBlank() || portNum == null || token.length < 16) {
                            toaster.show("请填写 IP、端口和至少 16 位的 Token")
                            return@Button
                        }
                        val node = RemoteNode(
                            label = label.ifBlank { "DSH 电脑" },
                            slug = RemoteNode.slugOf(label.ifBlank { "windows_dsh" }),
                            host = host.trim(),
                            port = portNum,
                            token = token.trim(),
                            enableTools = enableTools,
                            enableModels = enableModels,
                        )
                        if (!node.isValid) {
                            toaster.show("配置无效：名称只能用字母数字和下划线")
                            return@Button
                        }
                        scope.launch {
                            // 先保存节点，再同步生成标准配置（一次 update 原子写入）
                            settingsStore.update { current ->
                                val withNode = current.copy(
                                    remoteNodes = current.remoteNodes.filter { it.id != node.id } + node,
                                )
                                // 不自动勾选 assistant：保留产品原有的安全门
                                RemoteNodeSync.sync(withNode).first
                            }
                            toaster.show("已保存。请到 Assistant → MCP 勾选 dsh_${node.slug} 启用工具")
                        }
                    },
                ) { Text("保存并配置") }
                Spacer(Modifier.height(16.dp))
            }

            item { Text("已配置节点", style = MaterialTheme.typography.titleMedium) }
            items(settings.remoteNodes, key = { it.id }) { node ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(node.label, style = MaterialTheme.typography.titleSmall)
                        Text("${node.host}:${node.port}  token=${if (node.token.isBlank()) "无" else "***(${node.token.length})"}")
                        Text("工具=${node.enableTools}  模型=${node.enableModels}")
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(
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
