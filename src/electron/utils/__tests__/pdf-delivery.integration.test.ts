import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import PDFDocument from "pdfkit";
import { expect, it } from "vitest";

it("renders original vector pixels without Poppler and rejects a probe as a full translation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-delivery-native-"));
  const make = async (name: string, text: string) => new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: [600, 800] });
    const stream = fs.createWriteStream(path.join(dir, name));
    doc.pipe(stream);
    doc.rect(60, 80, 120, 160).fill("#ff0000");
    doc.fillColor("black").fontSize(9).text(text, 50, 280, { width: 480 });
    doc.end(); stream.on("finish", resolve).on("error", reject);
  });
  try {
    const body = "The original research document explains design, evaluation, decisions, systems, models, engineering, and results. ".repeat(18);
    await make("source.pdf", body);
    await make("probe.pdf", "Chinese font test only.");
    await make("translation.pdf", body);
    const result = JSON.parse(execFileSync(process.execPath, ["-e", `
      const ts=require('typescript'),fs=require('node:fs'),path=require('node:path');
      require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
      (async()=>{
        const dir=process.argv[1],root=process.cwd();
        const {renderPdfPages}=require(root+'/src/electron/utils/pdf-page-render.ts');
        const {PdfDeliveryReviewer}=require(root+'/src/electron/utils/pdf-delivery-review.ts');
        const render=await renderPdfPages(path.join(dir,'source.pdf'),path.join(dir,'crop'),{firstPage:1,lastPage:1,crop:{x:.1,y:.1,width:.2,height:.2}});
        const {loadImage,createCanvas}=require('@napi-rs/canvas');
        const img=await loadImage(render.pages[0].imagePath),canvas=createCanvas(img.width,img.height),ctx=canvas.getContext('2d');
        ctx.drawImage(img,0,0); const pixel=Array.from(ctx.getImageData(img.width/2,img.height/2,1,1).data);
        const reviewer=new PdfDeliveryReviewer();
        const reviews=await reviewer.review(dir,['probe.pdf','translation.pdf'],['source.pdf'],undefined,true);
        let invalid=false;try{await renderPdfPages(path.join(dir,'source.pdf'),path.join(dir,'bad'),{firstPage:1,lastPage:1,crop:{x:.9,y:0,width:.2,height:1}})}catch{invalid=true}
        console.log(JSON.stringify({render,pixel,reviews,invalid,rejected:reviewer.isRejected(dir,'probe.pdf')}));
      })().catch(e=>{console.error(e);process.exit(1)});
    `, dir], { encoding: "utf8", timeout: 30_000 }));
    expect(result.pixel).toEqual([255, 0, 0, 255]);
    expect(result.render.totalPages).toBe(1);
    expect(result.render.pages[0].text).toHaveLength(0);
    expect(result.invalid).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.reviews[0].issues.some((i: { type: string }) => i.type === "translation-incomplete")).toBe(true);
    expect(result.reviews[1].passed).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 40_000);
