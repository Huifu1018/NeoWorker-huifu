from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


OUTPUT = Path(__file__).resolve().parents[1] / "docs" / "neoworker-hermes-harness-open-plan.docx"

FONT = "STSong"
TEXT = "202020"
MUTED = "5F6875"
ACCENT = "243B53"
LIGHT_BLUE = "EAF1F7"
LIGHT_GRAY = "F3F5F7"
BORDER = "D9D9D9"
WHITE = "FFFFFF"


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    borders = tc_pr.find(qn("w:tcBorders"))
    if borders is not None:
        tc_pr.remove(shd)
        tc_pr.insert(tc_pr.index(borders) + 1, shd)
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)


def set_cell_borders(cell, color=BORDER, size="6"):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        shd = tc_pr.find(qn("w:shd"))
        if shd is None:
            tc_pr.append(borders)
        else:
            tc_pr.insert(tc_pr.index(shd), borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = "w:" + edge
        element = borders.find(qn(tag))
        if element is None:
            element = OxmlElement(tag)
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)


def set_cell_margins(cell, top=100, start=130, bottom=100, end=130):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn("w:" + margin))
        if node is None:
            node = OxmlElement("w:" + margin)
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_cell_width(cell, width_inches):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:w"), str(int(width_inches * 1440)))
    tc_w.set(qn("w:type"), "dxa")


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tr_pr.append(tbl_header)


def set_keep_with_next(paragraph, value=True):
    p_pr = paragraph._p.get_or_add_pPr()
    keep = p_pr.find(qn("w:keepNext"))
    if value and keep is None:
        node = OxmlElement("w:keepNext")
        spacing = p_pr.find(qn("w:spacing"))
        if spacing is None:
            p_pr.append(node)
        else:
            p_pr.insert(p_pr.index(spacing), node)
    elif not value and keep is not None:
        p_pr.remove(keep)


def set_keep_together(paragraph, value=True):
    p_pr = paragraph._p.get_or_add_pPr()
    keep = p_pr.find(qn("w:keepLines"))
    if value and keep is None:
        node = OxmlElement("w:keepLines")
        spacing = p_pr.find(qn("w:spacing"))
        if spacing is None:
            p_pr.append(node)
        else:
            p_pr.insert(p_pr.index(spacing), node)
    elif not value and keep is not None:
        p_pr.remove(keep)


def set_run_font(run, name=FONT, size=None, bold=None, color=TEXT, italic=None):
    run.font.name = name
    r_pr = run._element.get_or_add_rPr()
    r_fonts = r_pr.rFonts
    r_fonts.set(qn("w:ascii"), name)
    r_fonts.set(qn("w:hAnsi"), name)
    r_fonts.set(qn("w:eastAsia"), name)
    r_fonts.set(qn("w:cs"), name)
    r_fonts.set(qn("w:hint"), "eastAsia")
    lang = r_pr.find(qn("w:lang"))
    if lang is None:
        lang = OxmlElement("w:lang")
        r_pr.append(lang)
    lang.set(qn("w:val"), "zh-CN")
    lang.set(qn("w:eastAsia"), "zh-CN")
    lang.set(qn("w:bidi"), "ar-SA")
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)


def set_paragraph_format(paragraph, before=0, after=6, line=1.18, left=0, first=0):
    fmt = paragraph.paragraph_format
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    fmt.line_spacing = line
    fmt.left_indent = Inches(left)
    fmt.first_line_indent = Inches(first)


def add_text(paragraph, text, *, bold=False, color=TEXT, size=10.5, italic=False):
    run = paragraph.add_run(text)
    set_run_font(run, size=size, bold=bold, color=color, italic=italic)
    return run


def add_body(doc, text, after=6):
    p = doc.add_paragraph(style="Normal")
    set_paragraph_format(p, after=after, line=1.2)
    add_text(p, text)
    set_keep_together(p)
    return p


def add_bullet(doc, text, level=0):
    style = "List Bullet" if level == 0 else "List Bullet 2"
    p = doc.add_paragraph(style=style)
    set_paragraph_format(p, after=3, line=1.15)
    add_text(p, text)
    set_keep_together(p)
    return p


def add_number(doc, text):
    p = doc.add_paragraph(style="List Number")
    set_paragraph_format(p, after=3, line=1.15)
    add_text(p, text)
    set_keep_together(p)
    return p


def add_heading(doc, text, level=1):
    style = f"Heading {level}"
    p = doc.add_paragraph(style=style)
    set_keep_with_next(p)
    set_keep_together(p)
    return p


def add_heading_text(doc, text, level=1):
    p = add_heading(doc, text, level)
    add_text(p, text, bold=True, color=TEXT, size=14 if level == 1 else 11.5)
    return p


def add_label_paragraph(doc, label, text, after=5):
    p = doc.add_paragraph(style="Normal")
    set_paragraph_format(p, after=after, line=1.18)
    add_text(p, label, bold=True)
    add_text(p, text)
    set_keep_together(p)
    return p


def add_table(doc, headers, rows, widths, font_size=9.5, alternate=True):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    table.style = "Table Grid"
    header = table.rows[0]
    set_repeat_table_header(header)
    for idx, (cell, value, width) in enumerate(zip(header.cells, headers, widths)):
        set_cell_width(cell, width)
        set_cell_shading(cell, ACCENT)
        set_cell_borders(cell)
        set_cell_margins(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        set_paragraph_format(p, after=0, line=1.05)
        add_text(p, value, bold=True, color=WHITE, size=font_size)
    for row_index, values in enumerate(rows):
        cells = table.add_row().cells
        for idx, (cell, value, width) in enumerate(zip(cells, values, widths)):
            set_cell_width(cell, width)
            set_cell_borders(cell)
            set_cell_margins(cell, top=105, start=130, bottom=105, end=130)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            if alternate and row_index % 2 == 1:
                set_cell_shading(cell, LIGHT_BLUE)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            set_paragraph_format(p, after=0, line=1.08)
            add_text(p, str(value), size=font_size)
            set_keep_together(p)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table


def add_small_note(doc, text):
    p = doc.add_paragraph(style="Normal")
    set_paragraph_format(p, before=0, after=5, line=1.12)
    add_text(p, text, color=MUTED, size=9)
    return p


def add_page_field(paragraph):
    run = paragraph.add_run()
    set_run_font(run, size=9, color=MUTED)
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = " PAGE "
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char1)
    run._r.append(instr_text)
    run._r.append(fld_char2)


def configure_styles(doc):
    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT
    normal._element.rPr.rFonts.set(qn("w:ascii"), FONT)
    normal._element.rPr.rFonts.set(qn("w:hAnsi"), FONT)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    normal._element.rPr.rFonts.set(qn("w:cs"), FONT)
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(TEXT)

    title = styles["Title"]
    title.font.name = FONT
    title._element.rPr.rFonts.set(qn("w:ascii"), FONT)
    title._element.rPr.rFonts.set(qn("w:hAnsi"), FONT)
    title._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    title._element.rPr.rFonts.set(qn("w:cs"), FONT)
    title.font.size = Pt(22)
    title.font.bold = True
    title.font.color.rgb = RGBColor.from_string(TEXT)
    title.paragraph_format.space_before = Pt(0)
    title.paragraph_format.space_after = Pt(6)
    title_ppr = title._element.get_or_add_pPr()
    title_border = title_ppr.find(qn("w:pBdr"))
    if title_border is not None:
        title_ppr.remove(title_border)

    for level, size in ((1, 14), (2, 11.5), (3, 10.5)):
        style = styles[f"Heading {level}"]
        style.font.name = FONT
        style._element.rPr.rFonts.set(qn("w:ascii"), FONT)
        style._element.rPr.rFonts.set(qn("w:hAnsi"), FONT)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        style._element.rPr.rFonts.set(qn("w:cs"), FONT)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(TEXT)
        style.paragraph_format.space_before = Pt(12 if level == 1 else 8)
        style.paragraph_format.space_after = Pt(5)
        style_ppr = style._element.get_or_add_pPr()
        num_pr = style_ppr.find(qn("w:numPr"))
        if num_pr is not None:
            style_ppr.remove(num_pr)
        border = style_ppr.find(qn("w:pBdr"))
        if border is not None:
            style_ppr.remove(border)

    for style_name in ("List Bullet", "List Bullet 2", "List Number"):
        style = styles[style_name]
        style.font.name = FONT
        style._element.rPr.rFonts.set(qn("w:ascii"), FONT)
        style._element.rPr.rFonts.set(qn("w:hAnsi"), FONT)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        style._element.rPr.rFonts.set(qn("w:cs"), FONT)
        style.font.size = Pt(10.5)
        style.font.color.rgb = RGBColor.from_string(TEXT)


def build_document():
    doc = Document()
    configure_styles(doc)

    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.68)
    section.bottom_margin = Inches(0.62)
    section.left_margin = Inches(0.76)
    section.right_margin = Inches(0.76)
    section.header_distance = Inches(0.3)
    section.footer_distance = Inches(0.3)

    header = section.header
    hp = header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_paragraph_format(hp, after=0, line=1)
    add_text(hp, "NeoWorker Hermes Harness 开放计划", color=MUTED, size=8.5)

    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_paragraph_format(fp, before=0, after=0, line=1)
    add_text(fp, "开放草案  ·  2026年9月11日  ·  ", color=MUTED, size=8.5)
    add_page_field(fp)

    title = doc.add_paragraph(style="Title")
    add_text(title, "NeoWorker 使用 Hermes Harness 的开放计划", bold=True, color=TEXT, size=22)

    subtitle = doc.add_paragraph(style="Normal")
    set_paragraph_format(subtitle, after=12, line=1.1)
    add_text(subtitle, "技术策略草案 面向分阶段验证与评审", color=MUTED, size=11.5)

    metadata = [
        ["文档状态", "开放草案，可根据评测和产品反馈调整"],
        ["日期", "2026年9月11日"],
        ["适用范围", "NeoWorker-huifu 的 Agent Runtime、工具执行和任务交付链"],
        ["核心建议", "优先采用 Hermes ACP Harness；由 NeoWorker 保留工具、副作用和任务治理权"],
    ]
    add_table(doc, ["项目", "内容"], metadata, [1.12, 5.72], font_size=9.5, alternate=False)

    add_heading_text(doc, "一 结论", 1)
    add_body(
        doc,
        "建议把 Hermes ACP Harness 逐步作为 NeoWorker 处理复杂 Agent 任务的首选执行引擎，同时保留 NeoWorker 原生 Runtime 作为快速路径。Hermes 负责 Agent Loop、规划和多步推进，NeoWorker 负责工具筛选、权限审批、沙箱、任务状态、证据记录和最终交付。这个组合既能吸收 Hermes 的执行能力，也能保留 NeoWorker 对本地副作用的控制。",
    )
    add_body(
        doc,
        "这是一项可行的增量改造，不需要重写 NeoWorker 的工具体系。当前代码已经具备 Hermes ACP 适配、任务级 MCP Tool Host、权限桥接、checkpoint、暂停恢复和宿主工具多步验收能力。尚未完成的部分主要是产品路由、运行时可见性、能力覆盖评测，以及把当前的“显式 opt-in”推进成可控的 Auto 模式。",
    )
    add_label_paragraph(
        doc,
        "关键判断：",
        "“尽可能使用 Hermes”应理解为尽可能使用 Hermes 的 Agent Loop 和 Harness 能力，而不是把 Hermes 原生文件、Shell 和进程工具直接放回生产路径。生产任务的副作用仍应统一经过 NeoWorker Tool Host。",
    )

    add_heading_text(doc, "二 当前事实", 1)
    add_body(
        doc,
        "NeoWorker 目前存在三种 Hermes 相关接入方式。它们的执行语义不同，不能只看 Provider 名称或 OpenAI-compatible 接口来判断是否真正使用了 Hermes Harness。",
    )
    add_table(
        doc,
        ["接入方式", "谁运行 Agent Loop", "谁执行本地副作用", "适合的定位"],
        [
            ["Hermes Agent 8642", "Hermes", "Hermes", "完整 Hermes 外部 Runtime，NeoWorker 不拥有副作用"],
            ["Hermes Model Proxy 8645", "NeoWorker", "NeoWorker", "模型凭据转发，不等于 Hermes Harness"],
            ["Hermes ACP 适配器", "Hermes", "NeoWorker Tool Host", "推荐的生产桥接路径"],
        ],
        [1.55, 1.25, 1.55, 2.49],
        font_size=9.1,
    )
    add_body(
        doc,
        "从当前本地任务数据看，普通任务仍然没有进入 Hermes：已检查的任务中没有带有 Hermes external runtime 的任务，之前的航班查询也走的是 NeoWorker 原生 SessionRuntime。因此，之前截图中的差异更准确地说明“产品默认路由还没有启用 Hermes”，而不是说明 Hermes ACP 适配本身不可用。",
    )
    add_body(
        doc,
        "另一方面，仓库中的专项验证已经证明 ACP 宿主工具链可以工作：本机 Hermes Agent v0.18.0 能通过 NeoWorker Tool Host 完成 write_file 和 run_command，审批、工具生命周期、checkpoint 和结果边界均有验证。当前状态可以概括为：集成基础已具备，产品采用率仍接近零。",
    )
    add_small_note(
        doc,
        "依据：docs/hermes-runtime.md、docs/hermes-tool-ownership-audit.md 和 docs/hermes-test-report.md。上述文件记录了接入方式、工具所有权以及专项验证范围。",
    )

    add_heading_text(doc, "三 目标状态", 1)
    add_body(
        doc,
        "目标状态不是让两个 Runtime 互相覆盖，而是让它们形成清晰的分工。NeoWorker 负责“任务和工具的边界”，Hermes 负责“如何把复杂任务推进到完成”。",
    )
    add_table(
        doc,
        ["能力层", "建议归属", "目标行为"],
        [
            ["Agent Loop 和任务规划", "Hermes ACP", "Hermes 负责拆解目标、选择下一步、持续推进和处理工具结果"],
            ["工具目录和任务级筛选", "NeoWorker", "只向 Hermes 暴露当前任务获准使用的工具"],
            ["文件、Shell、Office 和其他副作用", "NeoWorker", "所有执行经过现有 Tool Host、审批、沙箱、超时和日志链"],
            ["任务状态和恢复", "NeoWorker 主导，Hermes 提供 session", "任务可暂停、恢复、重试，未知副作用必须显式确认"],
            ["用户界面和运行时状态", "NeoWorker", "明确显示 Native、Hermes Active、Fallback 或 Failed"],
            ["最终交付校验", "NeoWorker", "文件类任务只有在产物存在、可解析和通过基础检查后才能完成"],
        ],
        [1.65, 1.55, 3.64],
        font_size=9.1,
    )

    add_heading_text(doc, "四 运行模式", 1)
    add_body(
        doc,
        "建议在任务级别引入三种运行模式。模式必须持久化，并在任务时间线上留下可查询的运行时事件，避免用户根据界面猜测任务到底由谁执行。",
    )
    add_table(
        doc,
        ["模式", "默认行为", "适用情况", "失败处理"],
        [
            ["Auto", "根据任务特征自动选择", "复杂查询、网页研究、代码和多步文件任务优先 Hermes", "低风险任务可按策略降级；必须记录原因"],
            ["Hermes", "强制走 Hermes ACP", "用户明确要求 Hermes，或任务需要 Hermes 的多步执行能力", "不允许静默降级；启动失败应明确显示"],
            ["Native", "走 NeoWorker 原生 Runtime", "简单问答、单步操作、确定性工作流和调试场景", "保持现有原生错误和恢复语义"],
        ],
        [0.78, 1.85, 2.75, 1.46],
        font_size=9.0,
    )
    add_label_paragraph(
        doc,
        "路由原则：",
        "先按任务复杂度和工具数量判断，再结合工具类型、用户选择和历史失败情况修正。模型供应商或 Provider 名称不能作为“是否使用 Hermes Harness”的唯一信号。",
    )

    add_heading_text(doc, "五 任务路由建议", 1)
    add_table(
        doc,
        ["任务类型", "建议 Runtime", "原因和边界"],
        [
            ["网页查询和结构化数据采集", "Hermes ACP", "需要搜索、抓取、解析、去重、校验和总结等连续步骤"],
            ["代码、终端和调试", "Hermes ACP", "适合 Hermes 的计划、试错和结果反馈；命令仍由 NeoWorker 执行"],
            ["PPT、Word 和其他 Office 多步任务", "Hermes ACP", "适合先理解模板、再修改、再检查；必须增加产物完成门禁"],
            ["简单问答和短文本改写", "Native", "减少启动开销，避免把简单请求送入长 Agent Loop"],
            ["单次确定性工具调用", "Native 或 Auto", "由响应时间和审批策略决定"],
            ["依赖 Hermes 原生 Memory、Project Plugin 或特殊 Toolset 的任务", "先进入试验区", "当前宿主包装器会关闭这些能力，需先完成能力映射和所有权评估"],
        ],
        [1.9, 1.15, 3.79],
        font_size=8.9,
    )
    add_body(
        doc,
        "PPT 截图暴露出的“工具调用已经结束，但回答仍停在准备读取模板”属于另一个需要单独修复的问题：它可能是任务终态、产物校验或输出可见性问题，不能简单归因于是否使用 Hermes。无论 Runtime 选择什么，Office 任务都应在标记完成前验证最终文件。",
    )

    add_heading_text(doc, "六 分阶段开放计划", 1)
    add_body(
        doc,
        "下面的阶段按风险从低到高排列。每一阶段都有明确的产出和退出条件；如果评测结果不理想，可以停留在当前阶段，不必一次性做全量切换。",
    )

    add_heading_text(doc, "阶段 0 建立可见性和运行时契约", 2)
    add_body(doc, "先让用户和开发者能准确知道每个任务使用了什么 Runtime，以及任务为什么选择这条路径。")
    add_bullet(doc, "在任务设置或新建任务界面提供 Auto、Hermes、Native 三种模式，并把选择写入任务配置。")
    add_bullet(doc, "时间线显示 Hermes Active、Native Active、Fallback 和 Failed 等明确状态；记录 external runtime、Hermes 版本和宿主工具模式。")
    add_bullet(doc, "Hermes 模式启动失败时不静默切换到 Native。Auto 模式可以降级，但必须记录触发原因和是否已经发生工具副作用。")
    add_bullet(doc, "建立统一的完成契约，特别是 Office 文件任务必须通过文件存在、大小、解析和必要的预览检查。")
    add_label_paragraph(doc, "退出条件：", "用户可以从任务记录中确认实际 Runtime；强制 Hermes 任务不会被误标为 Native；失败和降级可追溯。")

    add_heading_text(doc, "阶段 1 让复杂任务默认进入 Hermes", 2)
    add_body(doc, "在不改变所有任务默认行为的前提下，先把 Hermes 用在最能体现差异的任务类型。")
    add_bullet(doc, "建立最小路由器：多工具、网页研究、结构化采集、代码调试和多步 Office 任务进入 Hermes ACP。")
    add_bullet(doc, "保留 Native 作为简单任务的快速路径，避免所有短请求承担 ACP 启动和会话开销。")
    add_bullet(doc, "为 Hermes 任务设置并发、超时、取消和资源上限；继续复用现有 Tool Host、审批、沙箱和日志。")
    add_bullet(doc, "收集真实任务样本，优先覆盖航班查询、网页抓取、代码修改、PPT 模板填充和文件整理。")
    add_label_paragraph(doc, "退出条件：", "候选任务的 Hermes 成功率、完成质量、耗时和用户修正成本不劣于 Native；没有未记录的本地副作用。具体数值在阶段 0 建立基线后确定。")

    add_heading_text(doc, "阶段 2 补齐 Hermes 能力覆盖", 2)
    add_body(doc, "当前包装器为了保证工具所有权，会关闭 Hermes workspace context、memory、project plugins 和 inherited kanban。阶段 2 要逐项判断哪些能力值得恢复，哪些能力应该由 NeoWorker 提供等价实现。")
    add_bullet(doc, "建立 Hermes 能力清单，区分 Agent Loop 能力、上下文能力、Memory 能力、插件能力和原生副作用工具。")
    add_bullet(doc, "优先把可治理的上下文和记忆能力接入 NeoWorker，而不是直接开放 Hermes 的本地副作用工具。")
    add_bullet(doc, "为每项新增能力写明数据来源、权限边界、任务范围、审计字段和恢复语义。")
    add_bullet(doc, "保留版本固定和 fail-closed 策略，在 Hermes 版本升级后重新运行 ACP、宿主工具、Windows Shell 和安装包 smoke。")
    add_label_paragraph(doc, "退出条件：", "需要 Hermes 能力的目标任务可以通过 NeoWorker 公开的治理接口获得相同或足够接近的结果，且所有权和恢复边界仍然清楚。")

    add_heading_text(doc, "阶段 3 扩大默认覆盖并优化体验", 2)
    add_body(doc, "当路由和能力覆盖稳定后，再把 Hermes 从“复杂任务优先”扩大为更普遍的默认体验。")
    add_bullet(doc, "根据评测结果调整 Auto 路由，允许用户按任务类型或工作区设置偏好。")
    add_bullet(doc, "继续利用 ACP 热会话、checkpoint 和受控重试，减少连续任务的启动开销。")
    add_bullet(doc, "把 Hermes 运行状态、工具审批、降级和产物检查统一成同一套任务视图。")
    add_bullet(doc, "将 Hermes 版本、模型、宿主工具协议和安装包 smoke 纳入固定发布门禁。")
    add_label_paragraph(doc, "退出条件：", "Hermes 成为复杂 Agent 任务的稳定默认路径，Native 仍能处理简单和特殊场景，用户能清楚理解两者差异。")

    add_heading_text(doc, "七 评测和发布门槛", 1)
    add_body(
        doc,
        "这项改造不能只用“能否启动 Hermes”来验收。核心问题是：任务是否完成得更好，副作用是否仍然受 NeoWorker 控制，用户是否能看懂运行时状态。",
    )
    add_table(
        doc,
        ["指标", "需要观察的结果", "最低门槛"],
        [
            ["Runtime 真实性", "任务实际进入的 Runtime 与界面和事件记录一致", "强制 Hermes 无法被静默替换"],
            ["工具所有权", "文件、Shell、Office 等副作用都能关联到 NeoWorker Tool Host", "零未知工具调用，零未记录副作用"],
            ["任务完成质量", "结果完整、准确、结构清楚，能通过用户验收", "不低于 Native 基线；复杂任务单独比较"],
            ["产物可靠性", "生成的 DOCX、PPTX 等文件存在且可解析", "未通过产物检查不得标记完成"],
            ["恢复安全", "暂停、取消、重试和重启不会自动重放未知副作用", "需要显式确认，且 checkpoint 可追踪"],
            ["体验和效率", "首字节、总耗时、工具审批次数和模型成本可比较", "建立基线后设定可接受范围"],
        ],
        [1.42, 3.75, 1.71],
        font_size=8.9,
    )
    add_label_paragraph(
        doc,
        "建议评测集：",
        "至少包含网页结构化采集、航班或商品查询、代码修改与测试、PPT 模板填充、Word 内容整理、文件批处理和需要审批的 Shell 操作。每类任务都应有 Native 与 Hermes ACP 的可比样本。",
    )

    add_heading_text(doc, "八 主要风险", 1)
    add_table(
        doc,
        ["风险", "表现", "应对"],
        [
            ["能力不完全等价", "当前包装器关闭 Hermes 的部分上下文、Memory 和插件能力", "先建立能力清单，按价值和治理成本逐项迁移"],
            ["运行时误判", "用户以为用了 Hermes，实际任务走了 Native 或静默降级", "运行模式持久化，时间线显示，强制模式禁止静默降级"],
            ["工具所有权混乱", "8642 或原生 ACP toolset 直接执行 Hermes 工具", "生产默认使用 ACP 宿主工具模式，副作用统一进入 NeoWorker Tool Host"],
            ["版本耦合", "当前要求 hermes-agent 0.18.0，升级可能改变 ACP 合同", "版本固定、fail-closed、升级后专项回归和安装包 smoke"],
            ["结果质量误归因", "模型、Prompt、数据源或工具差异被误认为 Harness 差异", "A/B 评测尽量固定模型、输入、工具目录和数据条件"],
            ["Office 任务终态不可靠", "工具调用完成但文件未生成或最终回答未收口", "增加产物校验和统一终态收口，Runtime 无关地执行"],
        ],
        [1.35, 3.06, 2.47],
        font_size=8.75,
    )

    add_heading_text(doc, "九 待确认事项", 1)
    add_number(doc, "NeoWorker 的默认体验是 Auto 优先，还是对所有新任务默认启用 Hermes？建议先选择 Auto。")
    add_number(doc, "哪些任务需要用户强制使用 Hermes？建议至少包括复杂研究、网页采集、代码调试和多步 Office 任务。")
    add_number(doc, "Hermes 的 Memory、workspace context 和 project plugins 中，哪些能力是必须保留的？哪些可以由 NeoWorker 提供等价接口？")
    add_number(doc, "Hermes 运行失败时，Auto 模式是否允许降级？允许降级的条件需要与“已经发生副作用”绑定。")
    add_number(doc, "模型和 Provider 是否在 A/B 评测中固定？如果不固定，需要把模型差异单独记录，避免把模型效果算到 Harness 上。")
    add_number(doc, "是否把 Hermes 版本升级设为独立发布门禁？当前建议把 `hermes-agent==0.18.0` 作为明确的运行时依赖，升级必须重新验收。")

    add_heading_text(doc, "十 建议的第一批工作", 1)
    add_body(
        doc,
        "第一批工作不必扩大 Hermes 的能力边界，先把已经接通的能力变成用户可选择、系统可观察、失败可解释的产品路径。",
    )
    add_bullet(doc, "实现任务级 Runtime 选择和配置持久化。")
    add_bullet(doc, "增加 Hermes Active、Native Active、Fallback 和 Failed 的时间线事件及 UI 标识。")
    add_bullet(doc, "实现 Auto 路由的最小版本，先覆盖多工具任务、网页研究、代码调试和多步 Office。")
    add_bullet(doc, "为强制 Hermes 任务关闭静默 fallback；为 Auto 任务记录降级原因。")
    add_bullet(doc, "建立第一版 A/B 评测集，并把航班查询和 PPT 模板任务纳入产物校验。")
    add_bullet(doc, "在本地和 CI 中继续保留 ACP、Tool Host、审批、Shell、checkpoint、Windows 和安装包验证。")
    add_label_paragraph(
        doc,
        "第一阶段的判断标准：",
        "用户能够明确知道任务是否真正使用 Hermes，复杂任务能够稳定经过 Hermes Agent Loop，NeoWorker 仍然拥有所有工具副作用，并且任何失败或降级都不会被伪装成成功。",
    )

    add_heading_text(doc, "附录 依据文件", 1)
    add_small_note(doc, "docs/hermes-runtime.md 记录三种 Hermes 接入方式、ACP Tool Host 边界和运行时生命周期。")
    add_small_note(doc, "docs/hermes-tool-ownership-audit.md 记录 Hermes Agent、Hermes Model Proxy 和 Hermes ACP 的工具所有权差异。")
    add_small_note(doc, "docs/hermes-test-report.md 记录 ACP 宿主工具、审批、checkpoint、恢复、Shell、跨平台和安装包专项验证。")
    add_small_note(doc, "src/electron/agent/executor.ts 包含 Hermes external runtime 的选择和执行分支；普通任务仍走 NeoWorker native SessionRuntime。")

    # Avoid widows around the final section and keep the document clean when opened in Word.
    for paragraph in doc.paragraphs:
        if paragraph.style.name.startswith("Heading"):
            set_keep_with_next(paragraph)
        for run in paragraph.runs:
            set_run_font(run, name=FONT, size=run.font.size.pt if run.font.size else None)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build_document()
