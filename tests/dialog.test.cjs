const test = require('node:test');
const assert = require('node:assert/strict');
const {dismissOnBackdrop} = require('../web/dialog.js');

class Dialog extends EventTarget {
  open = true;
  draft = '未提交的内容';
  getBoundingClientRect() { return {left:10, right:100, top:10, bottom:100}; }
  close() { this.open=false; this.dispatchEvent(new Event('close')); }
  pointer(type, x, y) {
    const event=new Event(type); Object.assign(event,{clientX:x,clientY:y}); this.dispatchEvent(event);
  }
}
test('backdrop dismisses without changing draft, inside clicks and drag-out do not', () => {
  const dialog=new Dialog();dismissOnBackdrop(dialog);
  dialog.pointer('pointerdown',20,20);dialog.pointer('click',20,20);assert.equal(dialog.open,true);
  dialog.pointer('pointerdown',20,20);dialog.pointer('click',0,0);assert.equal(dialog.open,true);
  dialog.pointer('pointerdown',0,0);dialog.pointer('pointercancel',0,0);dialog.pointer('click',0,0);assert.equal(dialog.open,true);
  let closed=0;dialog.addEventListener('close',()=>closed++);
  dialog.pointer('pointerdown',0,0);dialog.pointer('click',0,0);
  assert.equal(dialog.open,false);assert.equal(dialog.draft,'未提交的内容');assert.equal(closed,1);
});
test('backdrop respects cancellation guards and completion cancellation callbacks', () => {
  const dialog=new Dialog();dismissOnBackdrop(dialog);
  const guard=e=>e.preventDefault();dialog.addEventListener('cancel',guard);
  dialog.pointer('pointerdown',0,0);dialog.pointer('click',0,0);assert.equal(dialog.open,true);
  dialog.removeEventListener('cancel',guard);
  let result='pending';dialog.addEventListener('cancel',e=>{e.preventDefault();result=null;dialog.close();});
  dialog.pointer('pointerdown',0,0);dialog.pointer('click',0,0);
  assert.equal(result,null);assert.equal(dialog.open,false);
});
