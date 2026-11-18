package me.rerere.rikkahub.utils

/**
 * 移除字符串中的 Markdown 格式，得到用于朗读的纯文本
 *
 * 只保留正文：代码、公式和图片不朗读；HTML 标签、注释、style/script 块一并去掉，
 * 常见 HTML 实体解码成字符。标签名走白名单，避免把 `x<y && y>0` 这种正文当成标签删掉。
 * @return 移除 Markdown 格式后的纯文本
 */
fun String.stripMarkdown(): String {
    return this
        // HTML 注释与 style/script 块（含内容）
        .replace(Regex("<!--[\\s\\S]*?-->"), "")
        .replace(Regex("<(style|script)\\b[\\s\\S]*?</\\1\\s*>", RegexOption.IGNORE_CASE), "")
        // 代码块 (```...``` 和 `...`)
        .replace(Regex("```[\\s\\S]*?```|`[^`]*?`"), "")
        // 图片和链接保留文本
        .replace(Regex("!?\\[([^\\]]+)\\]\\([^\\)]*\\)"), "$1")
        // 加粗、斜体、删除线
        .replace(Regex("\\*\\*([^*]+?)\\*\\*"), "$1")
        .replace(Regex("\\*([^*]+?)\\*"), "$1")
        .replace(Regex("__([^_]+?)__"), "$1")
        .replace(Regex("_([^_]+?)_"), "$1")
        .replace(Regex("~~([^~]+?)~~"), "$1")
        // 标题、列表、引用、分割线
        .replace(Regex("(?m)^#+\\s*"), "")
        .replace(Regex("(?m)^\\s*[-*+]\\s+"), "")
        .replace(Regex("(?m)^\\s*\\d+\\.\\s+"), "")
        .replace(Regex("(?m)^>\\s*"), "")
        .replace(Regex("(?m)^(\\s*[-*_]){3,}\\s*$"), "")
        // 块级换行标签转成换行，避免把上下句粘连
        .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
        // 其余 HTML 标签：只认白名单标签名，正文里的 < > 不会被误删
        .replace(Regex("</?(?:$HTML_TAG_NAMES)(?:\\s[^<>]*)?/?>", RegexOption.IGNORE_CASE), "")
        // 常见 HTML 实体
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        // 去掉代码等内容后留下的空行和连续空格
        .replace(Regex("[ \\t]+\\n"), "\n")
        .replace(Regex("[ \\t]{2,}"), " ")
        .replace(Regex("\\n{2,}"), "\n")
        .trim()
}

private const val HTML_TAG_NAMES =
    "a|abbr|b|blockquote|br|code|del|details|div|em|h[1-6]|hr|i|img|ins|kbd|li|ol|p|pre|s|" +
        "script|span|strong|style|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul"

fun String.extractThinkingTitle(): String? {
    // 按行分割文本
    val lines = this.lines()

    // 从后往前查找最后一个符合条件的加粗文本行
    for (i in lines.indices.reversed()) {
        val line = lines[i].trim()

        // 检查是否为加粗格式且独占一整行
        val boldPattern = Regex("^\\*\\*(.+?)\\*\\*$")
        val match = boldPattern.find(line)

        if (match != null) {
            // 返回加粗标记内的文本内容
            return match.groupValues[1].trim().takeUnless { it.isBlank() }
        }
    }

    return null
}
