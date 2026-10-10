export const browserCapabilityApi = `
function __event(target, event, options = {}) {
  var started = __call({op:'event',target,action:'subscribe',event,...(options.frameId ? {frameId:options.frameId,frameKey:options.frameKey} : {})});
  var id, ready = started.then(result=>{id=result.data.subscriptionId;return id;});
  var cancelled = false, consumed;
  async function dispose() {cancelled=true;await ready;return __call({op:'event',target,action:'dispose',subscriptionId:id});}
  async function consume() {
    await ready;
    var deadline=Date.now()+(options.timeoutMs ?? 10000);
    try {
      while(!cancelled && Date.now()<deadline) {
        var result=await __call({op:'event',target,action:'poll',subscriptionId:id,timeoutMs:Math.min(1000,deadline-Date.now())});
        if(result.data.dropped)console.warn('Event buffer dropped '+result.data.dropped+' entries; narrow the event and verify the outcome');
        for(var item of result.data.events) if(!options.predicate || options.predicate(item.params)) return item;
      }
      throw Error(cancelled ? 'Event subscription disposed' : 'TIMEOUT: browser event not observed');
    } finally {await dispose().catch(()=>{});}
  }
  return Object.freeze({ready,dispose,then:(resolve,reject)=>(consumed??=consume()).then(resolve,reject)});
}
function __framePage(target, info) {
  var scoped={frameId:info.frameId,frameKey:info.frameKey};
  var call=async(action,fields={})=>(await __step({op:'frames',target,action,...scoped,...fields})).data;
  return Object.freeze({...info,
    evaluate:(fn,arg)=>call('evaluate',{expression:__expression(fn,arg)}),
    cdp:(method,params={})=>call('cdp',{method,params}),
    snapshot:()=>call('snapshot'),
    click:element=>call('click',typeof element==='number'?{backendNodeId:element}:{selector:element}),
    fill:(element,value)=>call('fill',{...(typeof element==='number'?{backendNodeId:element}:{selector:element}),value}),
    locator:selector=>Object.freeze({click:()=>call('click',{selector}),fill:value=>call('fill',{selector,value})}),
    getByRole:(role,options={})=>Object.freeze({click:async()=>{var state=await call('snapshot');var nodes=state.nodes.filter(n=>n.role===role && (options.name===undefined || n.name===options.name));if(nodes.length!==1)throw Error('Expected exactly one frame control');return call('click',{backendNodeId:nodes[0].backendNodeId});},fill:async value=>{var state=await call('snapshot');var nodes=state.nodes.filter(n=>n.role===role && (options.name===undefined || n.name===options.name));if(nodes.length!==1)throw Error('Expected exactly one frame control');return call('fill',{backendNodeId:nodes[0].backendNodeId,value});}}),
    upload:(selector,files)=>__step({op:'upload',target,selector,files,...scoped}),
    press:(keys)=>__step({op:'keys',target,keys,...scoped}),
    waitForEvent:(event,options={})=>__event(target,event,{...options,...scoped}),
  });
}
function __expression(fn,arg) {return typeof fn==='function' ? '('+fn.toString()+')('+(JSON.stringify(arg) ?? '')+')' : fn;}
var artifact=(name,data)=>__call({workspace:'artifact',name,value:typeof data==='string'?data:__encodeBytes(data),base64:typeof data!=='string'});
var checkpoint=(name,value)=>__call({workspace:'checkpoint',name,value});
var loadCheckpoint=name=>__call({workspace:'load',name});
var saveHelper=(name,fn)=>__call({workspace:'helper',name,value:typeof fn==='function'?'('+fn.toString()+')':fn});
var loadHelper=async name=>eval(await __call({workspace:'loadHelper',name}));
var showImage=async name=>{await __call({workspace:'image',name});return {displayed:true,path:name};};
var __hasDelivered=false,__deliveryValue;
var finish_from_js=({expression})=>{__deliveryValue=eval(expression);__hasDelivered=true;return {delivered:true};};
var reconnect=()=>browser.page(__lastTarget).reconnect();
`;
