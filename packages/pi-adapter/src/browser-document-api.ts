// Reads the document already opened by a PDF.js viewer, without downloading or reopening it.
export const browserDocumentApi = `
async function __readPdfText(options = {}) {
  var root=window;
  if(options.selector) {
    var selected=document.querySelector(options.selector);
    if(!selected)throw Error('PDF_TEXT_UNAVAILABLE: viewer selector was not found');
    root=selected.contentWindow || window;
  }
  var queue=[root],seen=new Set(),documents=[],layers=[];
  while(queue.length && seen.size<64) {
    var w=queue.shift(); if(seen.has(w))continue; seen.add(w);
    try {
      var d=w.document;
      var pdf=w.PDFViewerApplication?.pdfDocument;
      if(!pdf && w.PDFVar?._transport?.loadingTask?.promise) pdf=await w.PDFVar._transport.loadingTask.promise;
      if(pdf && typeof pdf.getPage==='function')documents.push({pdf,url:w.location.href});
      else {
        var rendered=[...d.querySelectorAll('.textLayer')].map(e=>e.innerText || e.textContent || '').filter(Boolean);
        if(rendered.length)layers.push({url:w.location.href,pages:rendered});
      }
      for(var f of d.querySelectorAll('iframe,frame'))if(f.contentWindow)queue.push(f.contentWindow);
    } catch(error) { if(!/SecurityError|cross-origin|Blocked a frame/i.test(String(error)))throw error; }
  }
  if(documents.length>1)throw Error('AMBIGUOUS_PDF: choose a viewer iframe with {selector}');
  if(!documents.length) {
    if(layers.length===1)return {source:'rendered-text',url:layers[0].url,pages:layers[0].pages.map((text,i)=>({page:i+1,text})),partial:true,warning:'Only rendered text layers were available; page numbers may not match the document. Use screenshots for missing pages.'};
    throw Error('PDF_TEXT_UNAVAILABLE: no readable PDF.js document found. Use frame handles for cross-origin content or screenshots for image-only PDFs.');
  }
  var viewer=documents[0],total=viewer.pdf.numPages;
  var from=Math.max(1,options.from || 1),to=Math.min(total,options.to || total,from+99);
  var budget=Math.min(800000,Math.max(1000,options.maxChars || 200000)),pages=[],clipped=false;
  for(var i=from;i<=to;i++) {
    var content=await (await viewer.pdf.getPage(i)).getTextContent();
    var text=content.items.map(item=>item.str+(item.hasEOL?'\\n':' ')).join('').trim();
    var take=text.slice(0,budget);pages.push({page:i,text:take,truncated:take.length!==text.length});budget-=take.length;
    if(take.length!==text.length || budget<=0){clipped=i<total || take.length!==text.length;break;}
  }
  return {source:'pdfjs',url:viewer.url,totalPages:total,pages,partial:clipped || from!==1 || to!==total,
    ...(pages.every(p=>!p.text)?{warning:'No text extracted; this may be an image-only PDF. Use screenshots.'}:{})};
}
`;
