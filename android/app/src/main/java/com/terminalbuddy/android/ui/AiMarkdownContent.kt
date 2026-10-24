package com.terminalbuddy.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.compose.MarkdownElement
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.MarkdownTypography
import com.mikepenz.markdown.model.ReferenceLinkHandler
import com.mikepenz.markdown.model.markdownAnimations
import com.mikepenz.markdown.model.markdownAnnotator
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.markdownPadding
import com.mikepenz.markdown.utils.getUnescapedTextInNode
import java.net.URI
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.conflate
import org.intellij.markdown.IElementType
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.ast.ASTNode

/** 只渲染 AI 正文；用户输入和工具执行记录继续使用原文。 */
@Composable
internal fun AiMarkdownContent(message: AiAnimatedMessage, style: TextStyle, modifier: Modifier = Modifier) {
    val cache = message.markdown
    LaunchedEffect(message) {
        // conflate 合并积压片段；不使用 debounce，持续流式输出也能持续得到解析结果。
        snapshotFlow { message.text }.conflate().collect { source ->
            cache.update(source)
            if (message.isRevealing) delay(48)
        }
    }
    val snapshot = cache.snapshot
    val originalUriHandler = LocalUriHandler.current
    val uriHandler = remember(originalUriHandler) {
        object : UriHandler {
            override fun openUri(uri: String) {
                if (isAiMarkdownWebLink(uri)) runCatching { originalUriHandler.openUri(uri) }
            }
        }
    }
    val linkStyles = TextLinkStyles(style = SpanStyle(color = TbColors.Accent, textDecoration = TextDecoration.Underline))
    val typography = markdownTypography(
        h1 = style.copy(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
        h2 = style.copy(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
        h3 = style.copy(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
        h4 = style.copy(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        h5 = style.copy(fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        h6 = style.copy(fontWeight = FontWeight.SemiBold),
        text = style, paragraph = style, ordered = style, bullet = style, list = style, quote = style,
        code = style.copy(fontSize = 13.sp, lineHeight = 20.sp, fontFamily = FontFamily.Monospace),
        inlineCode = style.copy(fontFamily = FontFamily.Monospace), textLink = linkStyles, table = style,
    )
    val firstLineStyle = snapshot?.parsed?.node?.firstAiTextStyle(typography) ?: style
    CompositionLocalProvider(LocalUriHandler provides uriHandler) {
        SelectionContainer(modifier.aiMessageFirstLine(firstLineStyle)) {
            val parsed = snapshot?.parsed
            if (snapshot == null) {
                // 首次解析只保留首行高度；已有快照更新时不会回到这一分支。
                Box(Modifier.fillMaxWidth().heightIn(min = 20.dp))
            } else if (parsed == null) {
                Text(snapshot.source, color = TbColors.Text, style = style)
            } else {
                val annotator = markdownAnnotator { content, node ->
                    if (node.type == MarkdownElementTypes.IMAGE) {
                        appendAiMarkdownImageLink(content, node, parsed.referenceLinkHandler, linkStyles)
                        true
                    } else false
                }
                val components = markdownComponents(image = { model ->
                    Text(
                        buildAnnotatedString {
                            appendAiMarkdownImageLink(model.content, model.node, parsed.referenceLinkHandler, linkStyles)
                        },
                        color = TbColors.Text, style = style,
                    )
                })
                Markdown(
                    state = parsed, modifier = Modifier.fillMaxWidth(), typography = typography,
                    colors = markdownColor(
                        text = TbColors.Text, codeBackground = TbColors.CanvasSoft, inlineCodeBackground = TbColors.CanvasSoft,
                        dividerColor = TbColors.Border, tableBackground = TbColors.CanvasSoft,
                    ),
                    padding = markdownPadding(
                        block = 6.dp, list = 2.dp, listItemTop = 2.dp, listItemBottom = 2.dp, listIndent = 12.dp,
                        codeBlock = PaddingValues(10.dp), blockQuote = PaddingValues(horizontal = 10.dp),
                    ),
                    dimens = markdownDimens(tableCellWidth = 140.dp, tableCellPadding = 8.dp),
                    // 文字高度以真实排版为准，避免与思考提示或其他消息叠在一起。
                    animations = markdownAnimations(animateTextSize = { this }),
                    annotator = annotator, components = components,
                    success = { state, blocks, blockModifier ->
                        Column(blockModifier) {
                            state.node.children.forEach { node ->
                                key(node.startOffset, node.type) { MarkdownElement(node, blocks, state.content) }
                            }
                        }
                    },
                )
            }
        }
    }
}

/** 首行可能是标题、代码或嵌套列表，使用与渲染相同的字体度量。 */
private fun ASTNode.firstAiTextStyle(typography: MarkdownTypography): TextStyle? = when (type) {
    MarkdownElementTypes.ATX_1, MarkdownElementTypes.SETEXT_1 -> typography.h1
    MarkdownElementTypes.ATX_2, MarkdownElementTypes.SETEXT_2 -> typography.h2
    MarkdownElementTypes.ATX_3 -> typography.h3
    MarkdownElementTypes.ATX_4 -> typography.h4
    MarkdownElementTypes.ATX_5 -> typography.h5
    MarkdownElementTypes.ATX_6 -> typography.h6
    MarkdownElementTypes.PARAGRAPH -> typography.paragraph
    MarkdownElementTypes.CODE_FENCE, MarkdownElementTypes.CODE_BLOCK -> typography.code
    else -> children.firstNotNullOfOrNull { it.firstAiTextStyle(typography) }
}

/** 图片首版展示为链接，避免自动下载及图片加载改变流式正文高度。 */
private fun AnnotatedString.Builder.appendAiMarkdownImageLink(
    content: String, node: ASTNode, references: ReferenceLinkHandler, styles: TextLinkStyles,
) {
    val label = node.findAiMarkdownNode(MarkdownElementTypes.LINK_TEXT)?.getUnescapedTextInNode(content)
        ?.removeSurrounding("[", "]")?.takeIf(String::isNotBlank) ?: "图片链接"
    val destination = node.findAiMarkdownNode(MarkdownElementTypes.LINK_DESTINATION)?.getUnescapedTextInNode(content)
        ?: node.findAiMarkdownNode(MarkdownElementTypes.LINK_LABEL)?.getUnescapedTextInNode(content)?.let(references::find)
        ?: references.find("[$label]")
    val url = destination.removeSurrounding("<", ">").trim()
    if (isAiMarkdownWebLink(url)) {
        withLink(LinkAnnotation.Url(url, styles)) { append(label) }
    } else append(label)
}

private fun ASTNode.findAiMarkdownNode(type: IElementType): ASTNode? {
    children.forEach { child ->
        if (child.type == type) return child
        child.findAiMarkdownNode(type)?.let { return it }
    }
    return null
}

internal fun isAiMarkdownWebLink(value: String): Boolean = runCatching {
    val uri = URI(value)
    uri.scheme?.lowercase(Locale.ROOT) in setOf("http", "https") && !uri.rawAuthority.isNullOrBlank()
}.getOrDefault(false)
