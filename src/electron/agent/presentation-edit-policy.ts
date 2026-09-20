/** Host-owned scope: model-authored slide plans cannot authorize restructuring. */
export function preservePresentationStructure(request: string, previous = false): boolean {
  const instruction = request.trim();
  if (/(?:不要|无需|不需要)(?:增加|拆分|扩展).{0,8}页|(?:不要|不)拆页|\b(?:do not|don't|without)\s+(?:add(?:ing)?|remov(?:e|ing)|split(?:ting)?).{0,20}\bslides?\b/iu.test(instruction)) return true;
  const keep = /(?:保持|保留|不改变|不增加|不要增加|无需增加|不扩页|不拆页).{0,12}(?:页数|单页|一页|页面|结构)|(?:保持|保留).{0,6}(?:一|1)页|\b(?:keep|preserve|same)\b.{0,25}\b(?:slide count|page count|single.slide|structure)\b/iu;
  if (keep.test(instruction)) return true;
  const expand = /(?:拆分|扩展|扩成|拆成|增加|新增|减少|删减|合并|重构).{0,12}(?:页|幻灯片)|\b(?:add|remove|split|expand|restructure)\b.{0,25}\b(?:slides?|pages?|deck)\b/iu;
  if (expand.test(instruction)) return false;
  if (/(?:优化|润色|精简|修改|改进|完善|修订|调整内容)|\b(?:optimi[sz]e|polish|refine|revise|edit|improve)\b/iu.test(instruction)) return true;
  return previous;
}

/** Only inherit a source for a scoped edit, never for a new unrelated query. */
export function isPresentationEditContinuation(request: string): boolean {
  return /^(?:请|帮我|再|继续|把|将|please\s+)*(?:(?:优化|润色|精简|修改|改进|完善|修订).{0,12}(?:内容|表达|文字|标题|正文|PPT|幻灯片)|(?:增加|新增|拆分|拆成|扩成|减少|删减|合并).{0,8}(?:页|幻灯片)|(?:polish|refine|revise|edit|improve|add|remove|split|expand)\b.{0,25}\b(?:content|wording|slides?|pages?|deck)\b)/iu.test(request.trim());
}

export const PRESENTATION_EDIT_GUIDANCE = `PPT 原稿内容优化：默认保留原页数、页面顺序、母版、版式和各文本框用途，不增加封面或自动拆页。
先检查源 PPTX 的每页文本框、字号和位置，再精简重复表达，保留数字、单位、项目名称、完成状态与目标的区别。
使用 create_presentation(sourcePath=原稿)；slides 与原稿逐页对应。复杂单页优先传 templateReplacements: [{shapeId: "实际形状 ID", text: "该框的完整优化文字"}]，仅修改指定文本框，其余指标和装饰保持原样。形状 ID 可用 Office 工具 get 或读取 OOXML 确认，不能猜测。
KPI 小框仅放指标，正文仅放正文，不把同一段填入多个框。没有明确授权时不得扩页、重排页面或删掉事实来通过检查。
导出后检查实际文件和预览。结构检查通过不等于人工视觉验证，不得无依据声称“逐页核对、无重叠”。遇到具体版式问题只修复相关文本框，最多尝试两次，然后保留草稿并说明具体问题，禁止反复生成或虚报完成。`;
