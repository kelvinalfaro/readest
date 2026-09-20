package com.readest.native_tts

import org.w3c.dom.Node
import java.io.ByteArrayInputStream
import java.io.File
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilderFactory

internal data class ColdEpubSpeech(
    val segments: List<ColdEpubSegment>,
    val startSection: Int,
)

internal data class ColdEpubSegment(val text: String, val sectionIndex: Int)

/**
 * Small, service-safe EPUB text reader used only when Android Auto starts
 * playback before Readest's Activity/WebView exists. It deliberately avoids
 * the UI reader and returns bounded speech chunks for Android TextToSpeech.
 */
internal object ColdEpubText {
    private const val MAX_SEGMENT_CHARS = 2_500
    private val blockElements = setOf(
        "address", "article", "aside", "blockquote", "br", "div", "figcaption", "footer",
        "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
        "p", "pre", "section", "table", "td", "th", "tr",
    )

    fun read(file: File, resumeCfi: String?): ColdEpubSpeech = ZipFile(file).use { zip ->
        val container = zip.getInputStream(
            zip.getEntry("META-INF/container.xml")
                ?: error("EPUB is missing META-INF/container.xml"),
        ).readBytes()
        val containerDoc = parseXml(container)
        val rootfiles = containerDoc.getElementsByTagNameNS("*", "rootfile")
        val opfPath = (0 until rootfiles.length)
            .asSequence()
            .map { rootfiles.item(it) }
            .mapNotNull { it.attributes?.getNamedItem("full-path")?.nodeValue }
            .firstOrNull()
            ?: error("EPUB container has no rootfile")
        val opfEntry = zip.getEntry(opfPath) ?: error("EPUB package document is missing")
        val opfDoc = parseXml(zip.getInputStream(opfEntry).readBytes())

        val manifest = mutableMapOf<String, String>()
        val items = opfDoc.getElementsByTagNameNS("*", "item")
        for (index in 0 until items.length) {
            val item = items.item(index)
            val id = item.attributes?.getNamedItem("id")?.nodeValue ?: continue
            val href = item.attributes?.getNamedItem("href")?.nodeValue ?: continue
            manifest[id] = resolveZipPath(opfPath.substringBeforeLast('/', ""), href)
        }

        val spinePaths = buildList {
            val itemRefs = opfDoc.getElementsByTagNameNS("*", "itemref")
            for (index in 0 until itemRefs.length) {
                val idref = itemRefs.item(index).attributes?.getNamedItem("idref")?.nodeValue ?: continue
                manifest[idref]?.let(::add)
            }
        }
        require(spinePaths.isNotEmpty()) { "EPUB spine is empty" }

        val startSection = spineIndexFromCfi(resumeCfi).coerceIn(0, spinePaths.lastIndex)
        val segments = buildList {
            for (sectionIndex in startSection..spinePaths.lastIndex) {
                val entry = zip.getEntry(spinePaths[sectionIndex]) ?: continue
                addAll(
                    extractSegments(zip.getInputStream(entry).readBytes()).map {
                        ColdEpubSegment(it, sectionIndex)
                    }
                )
            }
        }
        ColdEpubSpeech(segments, startSection)
    }

    internal fun spineIndexFromCfi(cfi: String?): Int {
        val packageStep = Regex("""epubcfi\(/6/(\d+)""").find(cfi.orEmpty())
            ?.groupValues
            ?.getOrNull(1)
            ?.toIntOrNull()
            ?: return 0
        return (packageStep / 2 - 1).coerceAtLeast(0)
    }

    private fun extractSegments(bytes: ByteArray): List<String> {
        val text = try {
            val document = parseXml(bytes)
            val body = document.getElementsByTagNameNS("*", "body").item(0) ?: document.documentElement
            buildString { appendNodeText(body, this) }
        } catch (_: Exception) {
            // EPUB requires XHTML, but tolerate old books with HTML-ish markup.
            bytes.toString(Charsets.UTF_8)
                .replace(Regex("(?is)<(script|style|svg|math)[^>]*>.*?</\\1>"), " ")
                .replace(Regex("(?i)<br\\s*/?>|</?(p|div|li|h[1-6]|section|article|tr)[^>]*>"), "\n")
                .replace(Regex("(?s)<[^>]+>"), " ")
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
        }
        return text.lineSequence()
            .map { it.replace(Regex("\\s+"), " ").trim() }
            .filter { it.isNotEmpty() }
            .flatMap(::splitLongSegment)
            .toList()
    }

    private fun splitLongSegment(text: String): Sequence<String> = sequence {
        if (text.length <= MAX_SEGMENT_CHARS) {
            yield(text)
            return@sequence
        }
        var pending = StringBuilder()
        for (sentence in text.split(Regex("(?<=[.!?])\\s+"))) {
            if (pending.isNotEmpty() && pending.length + sentence.length + 1 > MAX_SEGMENT_CHARS) {
                yield(pending.toString())
                pending = StringBuilder()
            }
            if (sentence.length > MAX_SEGMENT_CHARS) {
                if (pending.isNotEmpty()) {
                    yield(pending.toString())
                    pending = StringBuilder()
                }
                for (chunk in sentence.chunked(MAX_SEGMENT_CHARS)) yield(chunk)
            } else {
                if (pending.isNotEmpty()) pending.append(' ')
                pending.append(sentence)
            }
        }
        if (pending.isNotEmpty()) yield(pending.toString())
    }

    private fun appendNodeText(node: Node, output: StringBuilder) {
        when (node.nodeType) {
            Node.TEXT_NODE, Node.CDATA_SECTION_NODE -> output.append(node.nodeValue)
            Node.ELEMENT_NODE -> {
                val name = (node.localName ?: node.nodeName).lowercase()
                if (name in setOf("script", "style", "svg", "math")) return
                if (name in blockElements) output.append('\n')
                val children = node.childNodes
                for (index in 0 until children.length) appendNodeText(children.item(index), output)
                if (name in blockElements) output.append('\n')
            }
        }
    }

    private fun parseXml(bytes: ByteArray) = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
        setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        setFeature("http://xml.org/sax/features/external-general-entities", false)
        setFeature("http://xml.org/sax/features/external-parameter-entities", false)
    }.newDocumentBuilder().parse(ByteArrayInputStream(bytes))

    private fun resolveZipPath(base: String, href: String): String {
        val decoded = try {
            java.net.URI(href).path ?: href
        } catch (_: Exception) {
            href
        }
        val parts = ArrayDeque<String>()
        for (part in listOf(base, decoded).filter { it.isNotEmpty() }.joinToString("/").split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> if (parts.isNotEmpty()) parts.removeLast()
                else -> parts.addLast(part)
            }
        }
        return parts.joinToString("/")
    }
}
