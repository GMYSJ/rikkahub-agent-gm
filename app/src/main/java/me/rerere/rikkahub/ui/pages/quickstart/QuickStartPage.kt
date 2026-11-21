package me.rerere.rikkahub.ui.pages.quickstart

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import me.rerere.rikkahub.R
import me.rerere.rikkahub.ui.components.nav.BackButton
import me.rerere.rikkahub.ui.theme.CustomColors
import org.koin.androidx.compose.koinViewModel

/**
 * 快速入门页（迁移自官方 3.3.1，简化版）。
 *
 * 官方版本有两个标签：「通用配置」和「从 DeepSeek 迁移」。
 * DeepSeek 迁移依赖官方 3.x 对 Conversation 数据模型的 config 字段改造
 * （ConversationConfig / DeepSeekMigrator / DeepSeekImporter），
 * 这属于数据库与数据结构层面的大改，需要单独评估旧数据兼容。
 * 本阶段先迁移「通用配置」标签 —— 引导用户配置模型/服务商/搜索/TTS，
 * 这是用户打开 app 就能看到并使用的新功能。
 */
@Composable
fun QuickStartPage(vm: QuickStartVM = koinViewModel()) {
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    Scaffold(
        topBar = {
            LargeFlexibleTopAppBar(
                title = { Text(stringResource(R.string.quick_start_page_title)) },
                navigationIcon = { BackButton() },
                scrollBehavior = scrollBehavior,
                colors = CustomColors.topBarColors,
            )
        },
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        containerColor = CustomColors.topBarColors.containerColor,
    ) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding)
        ) {
            QuickStartGeneralTab(vm = vm)
        }
    }
}
