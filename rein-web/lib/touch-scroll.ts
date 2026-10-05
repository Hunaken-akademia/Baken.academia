// A horizontal table owns its gesture even at its first/last column.
// Never hand a gesture that began here to tabs or page navigation.
export function ownsHorizontalGesture(target:EventTarget|null,boundary:HTMLElement|null){
 if(!target||!boundary)return false;
 const element=target as HTMLElement;
 if(typeof element.closest!=='function')return false;
 if(element.closest('input,textarea,select,[data-no-swipe]'))return true;
 let node:HTMLElement|null=element;
 const view=boundary.ownerDocument.defaultView;
 while(node){
  const overflow=view?.getComputedStyle(node).overflowX;
  if((overflow==='auto'||overflow==='scroll')&&node.scrollWidth>node.clientWidth+1)return true;
  if(node===boundary)break;
  node=node.parentElement;
 }
 return false;
}
