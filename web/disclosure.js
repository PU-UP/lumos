'use strict';
window.LumosDisclosure=(()=>{
  const states=new Map(),bindings=new WeakMap(),prefix='lumos.disclosure.v1.';
  function save(key,state){
    if(state.node)state.open=state.node.open;
    try{localStorage.setItem(prefix+key,JSON.stringify(state.open));}catch{}
  }
  function remember(node,key,initiallyOpen=false){
    const previousKey=bindings.get(node);
    if(previousKey===key)return node;
    if(previousKey){const previous=states.get(previousKey);save(previousKey,previous);previous.node=null;}
    let state=states.get(key);
    if(!state){
      let saved;try{saved=JSON.parse(localStorage.getItem(prefix+key));}catch{}
      state={open:typeof saved==='boolean'?saved:initiallyOpen};
    }
    // Read live state before replacing a node, even if its toggle event is still queued.
    node.open=state.node?state.node.open:state.open;
    state.node=node;states.set(key,state);bindings.set(node,key);
    node.addEventListener('toggle',()=>{if(states.get(key)?.node===node)save(key,state);});
    return node;
  }
  window.addEventListener('pagehide',()=>{for(const [key,state] of states)save(key,state);});
  return {remember};
})();
