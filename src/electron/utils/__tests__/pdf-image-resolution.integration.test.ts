import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("checks printed image resolution, including rotation and nested PDF forms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-image-resolution-"));
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["-e", `
      const ts=require('typescript'),fs=require('node:fs'),path=require('node:path');
      require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
      (async()=>{
        const {PDFDocument,degrees,rgb}=require('pdf-lib');
        const {createCanvas}=require('@napi-rs/canvas');
        const {reviewPdfLayout}=require(process.cwd()+'/src/electron/utils/pdf-layout-review.ts');
        const dir=process.argv[1], doc=await PDFDocument.create();
        const make=async size=>{const c=createCanvas(size,size),x=c.getContext('2d');x.fillStyle='#23456a';x.fillRect(0,0,size,size);return doc.embedPng(c.toBuffer('image/png'));};
        const low=await make(400),high=await make(2400);
        doc.addPage([600,800]).drawImage(low,{x:50,y:100,width:400,height:400});
        doc.addPage([600,800]).drawImage(high,{x:50,y:100,width:400,height:400});
        doc.addPage([600,800]).drawImage(low,{x:500,y:100,width:400,height:400,rotate:degrees(90)});
        doc.addPage([600,800]).drawImage(low,{x:50,y:100,width:60,height:60});
        doc.addPage([600,800]).drawRectangle({x:50,y:100,width:400,height:400,color:rgb(.2,.3,.5)});
        const file=path.join(dir,'raster.pdf');fs.writeFileSync(file,await doc.save());
        const nested=await PDFDocument.create();const [form]=await nested.embedPdf(fs.readFileSync(file),[0]);
        nested.addPage([600,800]).drawPage(form,{x:0,y:0,width:600,height:800});
        const nestedFile=path.join(dir,'nested.pdf');fs.writeFileSync(nestedFile,await nested.save());
        const review=await reviewPdfLayout(file,{minimumImageDpi:180}), nestedReview=await reviewPdfLayout(nestedFile,{minimumImageDpi:180});
        console.log(JSON.stringify({review,nestedReview}));
      })().catch(e=>{console.error(e);process.exit(1)});
    `, dir], { encoding: "utf8", timeout: 30_000 }));
    expect(result.review.issues.map((issue: { page: number }) => issue.page)).toEqual([1, 3]);
    expect(result.review.issues[0].type).toBe("low-resolution-image");
    expect(result.review.issues[0].message).toContain("72 effective DPI");
    expect(result.nestedReview.issues[0].type).toBe("low-resolution-image");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 40_000);
