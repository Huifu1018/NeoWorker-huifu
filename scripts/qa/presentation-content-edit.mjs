// Exercise the packaged Python adapter against native Office files, not mocks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'neoworker-content-edit-'));
const source = path.join(root, 'source.pptx');
const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
pptx.defineSlideMaster({ title: 'REPORT', background: { color: 'FFFFFF' }, objects: [
  { rect: { x: 0, y: 0, w: 0.15, h: 7.5, fill: { color: '0075AA' }, line: { color: '0075AA' } } },
] });
const slide = pptx.addSlide('REPORT');
slide.addText('Quarterly report', { x: .5, y: .3, w: 12, h: .6, fontSize: 28, color: '0075AA' });
for (let i = 0; i < 4; i++) slide.addText(`${i + 1} confirmed KPI`, { x: .5 + i * 3, y: 1.1, w: 2.8, h: .45, fontSize: 16, fill: {color:'EDF5FA'} });
slide.addText('Original progress\nOriginal risk\nOriginal next steps', { x: .5, y: 1.9, w: 12, h: 4.8, fontSize: 20 });
await pptx.writeFile({fileName: source});
const python = process.env.NEOWORKER_PYTHON || 'python3';
const adapter = path.resolve('resources/skills/ppt-master/scripts/neoworker_template_fill.py');
const bodyId = execFileSync(python, ['-c', `import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 t=E.fromstring(z.read('ppt/slides/slide1.xml'));ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
 for s in t.findall('.//p:sp',ns):
  if 'Original progress' in ''.join(n.text or '' for n in s.findall('.//a:t',ns)): print(s.find('p:nvSpPr/p:cNvPr',ns).get('id'))`, source], {encoding:'utf8'}).trim();
assert.ok(bodyId);
async function run(name, slides) {
 const plan = path.join(root, `${name}.json`), output = path.join(root, `${name}.pptx`);
 await writeFile(plan, JSON.stringify(slides));
 execFileSync(python, [adapter, '--source', source, '--slides-json', plan, '--project', path.join(root,name), '--output', output, '--preserve-slide-structure'], {stdio:'pipe',timeout:120000});
 return output;
}
const body = ['Progress: delivered the pilot.', 'Risk: capacity approval is pending.', 'Next: confirm resources before rollout.'];
const generic = await run('generic', [{title:'Quarterly update',content:body}]);
const explicit = await run('explicit', [{templateReplacements:[{shapeId:bodyId,text:body.join('\n')}]}]);
execFileSync(python, ['-c', `import sys,zipfile,xml.etree.ElementTree as E
ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as src:
 original=E.fromstring(src.read('ppt/slides/slide1.xml'))
 for filename in sys.argv[2:]:
  with zipfile.ZipFile(filename) as out:
   presentation=E.fromstring(out.read('ppt/presentation.xml'))
   assert len(presentation.findall('p:sldIdLst/p:sldId',ns))==1
   rels=E.fromstring(out.read('ppt/_rels/presentation.xml.rels'))
   rid=presentation.find('p:sldIdLst/p:sldId',ns).get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
   target=next(r.get('Target') for r in rels if r.get('Id')==rid)
   tree=E.fromstring(out.read(target.lstrip('/') if target.startswith('/') else 'ppt/'+target))
   text='\\n'.join(n.text or '' for n in tree.findall('.//a:t',ns))
   assert text.count('Progress: delivered the pilot.')==1
   assert text.count('Risk: capacity approval is pending.')==1
   for s in original.findall('.//p:sp',ns):
    if 'confirmed KPI' in ''.join(n.text or '' for n in s.findall('.//a:t',ns)):
     sid=s.find('p:nvSpPr/p:cNvPr',ns).get('id')
     match=next(v for v in tree.findall('.//p:sp',ns) if v.find('p:nvSpPr/p:cNvPr',ns).get('id')==sid)
     assert E.tostring(match)==E.tostring(s), sid
   for name in src.namelist():
    if not name.endswith('/') and name.startswith(('ppt/slideMasters/','ppt/slideLayouts/','ppt/theme/','ppt/media/')): assert src.read(name)==out.read(name),name
`, source, generic, explicit], {stdio:'pipe'});
await assert.rejects(run('expanded', Array.from({length:7},()=>({title:'Unauthorized expansion'}))));
await assert.rejects(stat(path.join(root,'expanded.pptx')), {code:'ENOENT'});
console.log(JSON.stringify({status:'passed',slides:1,kpisPreserved:4,bodyCopies:1,expansionRejected:true,source,generic,explicit},null,2));
