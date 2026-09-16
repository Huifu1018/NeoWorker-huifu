import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { extractPptxContentFromFile, extractPptxStructuredContentFromFile } from '../../src/electron/utils/pptx-extractor';

let tempDirs: string[] = [];

async function createTempPptx(slideXml: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neoworker-pptx-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'sample.pptx');
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(filePath, buffer);
  return filePath;
}

describe('pptx-extractor', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it('extracts slide text from pptx files', async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>Hello from slide</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath);
    expect(content).toContain('[PPTX Slides: 1]');
    expect(content).toContain('Hello from slide');
  });

  it('uses presentation order, ignores orphan parts, and numbers slides consecutively', async () => {
    const slide = (text: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const file = await createTempPptx(slide('Orphan'));
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    zip.file('ppt/slides/slide3.xml', slide('Second'));
    zip.file('ppt/slides/slide5.xml', slide('First'));
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="first"/><p:sldId id="257" r:id="second"/></p:sldIdLst></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide5.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide3.xml"/></Relationships>');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await extractPptxStructuredContentFromFile(file);
    expect(result.slideCount).toBe(2);
    expect(result.slides.map(({ index, text }) => ({ index, text }))).toEqual([{ index: 1, text: 'First' }, { index: 2, text: 'Second' }]);
  });

  it('applies output truncation limit when configured', async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>${'A'.repeat(500)}</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath, { outputCharLimit: 120 });
    expect(content).toContain('[... Content truncated. Showing first');
  });
});
