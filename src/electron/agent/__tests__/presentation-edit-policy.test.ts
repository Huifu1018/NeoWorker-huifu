import { describe, expect, it } from 'vitest';
import { preservePresentationStructure } from '../presentation-edit-policy';
describe('presentation content edit scope', () => {
  it.each(['基于PPT形式，优化内容，同样使用这个PPT模板', '优化这个 PPT', 'polish the attached deck', '精简内容，不增加页面', '保持一页，优化表达', "polish content, don't add slides", '不需要增加很多页', '不要拆页'])('preserves structure for %s', request => {
    expect(preservePresentationStructure(request)).toBe(true);
  });
  it.each(['拆成七页', '优化内容，增加两页', 'expand the deck into 7 slides', 'remove 2 slides'])('allows explicit restructuring: %s', request => {
    expect(preservePresentationStructure(request, true)).toBe(false);
  });
  it('does not impose the source page count on a new template-based deck', () => {
    expect(preservePresentationStructure('基于 PDF 内容使用模板生成 PPT')).toBe(false);
  });
  it('retains scope for a continuation', () => expect(preservePresentationStructure('继续', true)).toBe(true));
});
