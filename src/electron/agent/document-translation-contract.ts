import { compactGeneratedAttachmentContent, extractOfficeAttachmentKinds, stripGeneratedTaskContext } from "./task-intent-query";

export interface DocumentTranslationContract {
  request: string;
  preserveSource: boolean;
}

export function buildDocumentTaskMessage(task: { rawPrompt?: unknown; userPrompt?: unknown; prompt?: unknown; title?: unknown }): string {
  const instruction = stripGeneratedTaskContext(task.rawPrompt || task.userPrompt || task.prompt || task.title);
  for (const value of [task.rawPrompt, task.userPrompt, task.prompt]) {
    const text = String(value || "");
    const section = /(?:^|\n)\s*Attached files(?: \(relative to workspace\))?:/.exec(text);
    if (section) return `${instruction}\n\n${compactGeneratedAttachmentContent(text.slice(section.index)).trim()}`;
  }
  return instruction;
}

export function resolveDocumentTranslationContract(
  message: string,
  previous?: DocumentTranslationContract,
): DocumentTranslationContract {
  const instruction = stripGeneratedTaskContext(message);
  if (/^(?:继续|继续处理|重试|再试一次|continue|retry|try again)[。.!！\s]*$/i.test(instruction)) {
    return previous || { request: message, preserveSource: false };
  }
  // Only user-authored instructions can authorize redesign, never source text.
  const withoutNegations = instruction.replace(
    /(?:不要|不能|禁止|不允许|别|不|do not|don't|never)\s*(?:重新设计|重新排版|重做|更换模板|换模板|使用新模板|新建模板|redesign|rebuild|retemplate|use a new template)/gi,
    "",
  );
  const redesign = /(?:重新设计|重新排版|重做|更换模板|换模板|使用新模板|新建模板)|\b(?:redesign|rebuild|retemplate|use a new template)\b/i.test(withoutNegations);
  const translate = /(?:翻译|汉化|本地化|译成|译为)|\b(?:translate|translation|locali[sz]e)\b/i.test(instruction)
    || /(?:中文|英文|日语|日文|韩语|韩文|阿拉伯语|俄语).{0,6}版本/.test(instruction);
  const hasDocument = extractOfficeAttachmentKinds(message).length > 0
    || /\.(?:pptx?|potx|xlsx?|xlsm|docx?|pdf|od[pts]|csv|rtf)\b|(?:PPT|PDF|Excel|Word|文档|原文件|原稿|附件|幻灯片|工作簿)/i.test(instruction)
    || (translate && previous?.preserveSource === true);
  const preserveSource = Boolean(translate && hasDocument && !redesign);
  const carrySource = preserveSource && previous?.preserveSource
    && extractOfficeAttachmentKinds(message).length === 0
    && !/\.(?:pptx?|xlsx?|docx?|pdf)\b/i.test(instruction);
  return {
    request: carrySource ? buildDocumentTaskMessage({ rawPrompt: message, prompt: previous.request }) : message,
    preserveSource,
  };
}

export const DOCUMENT_TRANSLATION_GUIDANCE = [
  "SOURCE-PRESERVING DOCUMENT TRANSLATION (required):",
  "Translate the existing document, not a new report or a redesigned template. Keep one independent copy per source; never overwrite inputs.",
  "For PPTX, DOCX and XLSX use office_translation: inspect with targetLanguage, translate nextUnits with the configured task model, stage each batch, repeat until remaining=0, then apply. On interruption inspect with the same targetLanguage to resume saved batches. Do not rewrite a whole manifest or install Python. Do not send document text to public translation sites or alternate providers. Grouped units preserve matching run styles; never leave a unit blank or merge across ids. Intermediate JSON files are never deliverables.",
  "Preserve masters, layouts, pictures and their positions, styles, tables, formulas, numeric values, relationships and sheet/slide order. Keep names/formulas unchanged when they are identifiers. Text inside pictures is not translated by this tool and must be disclosed.",
  "For PDF and legacy formats, do not use generate_document/create_document to rebuild the source. If reliable in-place translation with image placement and target-language typography is unavailable, explain the limitation and ask before changing layout or format. Never append extracted pictures as a substitute for original placement.",
  "A valid file or rendered preview alone does not prove source fidelity, translation completeness, or text fit. State the checks actually performed. Never publish test/probe files as deliverables.",
].join("\n");

export function getDocumentTranslationToolError(
  contract: DocumentTranslationContract | undefined,
  toolName: string,
): string | null {
  if (!contract?.preserveSource) return null;
  if (!new Set([
    "create_presentation", "generate_presentation", "create_document", "generate_document",
    "create_spreadsheet", "generate_spreadsheet", "generate_epub", "compile_latex",
  ]).has(toolName)) return null;
  return "当前任务是原文件翻译，不能使用新建文档工具替换原模板。PPTX、DOCX、XLSX 请使用 office_translation 的 inspect/apply 流程；PDF 或不支持的格式应说明保版式限制，未经用户同意不得重新排版。";
}
