package com.terminalbuddy.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.HorizontalAlignmentLine
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import kotlin.math.roundToInt

/** 将头像中心对到正文首行中心，嵌套段落的留白由实际基线自动计入。 */
internal val AiMessageFirstLineCenter = HorizontalAlignmentLine { first, second -> minOf(first, second) }

@Composable
internal fun Modifier.aiMessageFirstLine(style: TextStyle): Modifier {
    val measurer = rememberTextMeasurer()
    val reference = remember(measurer, style) {
        measurer.measure(AnnotatedString("Hg"), style = style, maxLines = 1)
    }
    val lineCenter = (reference.getLineTop(0) + reference.getLineBottom(0)) / 2f
    val baselineOffset = reference.firstBaseline - lineCenter
    return layout { measurable, constraints ->
        val content = measurable.measure(constraints)
        val baseline = content[FirstBaseline]
        val center = if (baseline == AlignmentLine.Unspecified) lineCenter else baseline - baselineOffset
        layout(content.width, content.height, mapOf(AiMessageFirstLineCenter to center.roundToInt())) {
            content.placeRelative(0, 0)
        }
    }
}
