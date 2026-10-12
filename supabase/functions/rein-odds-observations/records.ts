export const BETS:Record<string,string>={"odds90-7354":"win","odds90-6337":"bracket_quinella","odds90-9769":"trio","odds90-2537":"quinella","odds90-46606":"bracket_quinella","odds90-10935":"trio","odds90-4114":"bracket_quinella","odds90-6341":"bracket_quinella","odds90-43158":"trio","odds90-683":"win"};
export function observationRecord(item:any,snapshot:any,now=Date.now()) {
  const starts=Date.parse(snapshot.starts_at),at=Date.parse(item?.fetchedAt),id=snapshot.race_id,bet=BETS[item?.ruleId];
  if(!bet||snapshot.slot!=="live"||item?.state!=="ready"||!Number.isFinite(starts)||now>=starts||!Number.isFinite(at)||at>now||now-at>600_000||at>=starts||snapshot.payload?.scratched?.length)throw new Error("Not a valid prestart observation");
  if((bet==="quinella")!==(id.length===12)||!Array.isArray(item.selections)||!item.selections.length||item.selections.length>3)throw new Error("Invalid rule or tickets");
  const runners=snapshot.payload.horses??[],numbers=new Set(runners.map((h:any)=>h.number)),gates=new Set(runners.map((h:any)=>h.gate));
  const keys=new Set<string>();
  for(const q of item.selections){
    const arity=bet==="win"?1:bet==="trio"?3:2;
    if(!Array.isArray(q.numbers)||q.numbers.length!==arity||q.numbers.some((n:any)=>!Number.isInteger(n)||n<1||n>(bet==="bracket_quinella"?8:18))||!Number.isFinite(q.odds)||q.odds<1)throw new Error("Invalid ticket");
    if(q.numbers.some((n:number)=>!(bet==="bracket_quinella"?gates:numbers).has(n))||(bet!=="bracket_quinella"&&new Set(q.numbers).size!==arity))throw new Error("Ticket outside roster");
    if(bet==="bracket_quinella"&&q.numbers[0]===q.numbers[1]&&runners.filter((h:any)=>h.gate===q.numbers[0]).length<2)throw new Error("Frame pair unavailable");
    const key=q.numbers.join("-");if(keys.has(key))throw new Error("Duplicate ticket");keys.add(key);
  }
  const roster=[...numbers].sort((a:any,b:any)=>a-b).join("-");
  return {race_id:id,rule_id:item.ruleId,odds_at:new Date(at).toISOString(),starts_at:snapshot.starts_at,payload:{...item,roster,bet,saved:true},stake_yen:100*item.selections.length};
}
export function settleObservation(row:any,body:any) {
  const review=body?.review;if(!review?.isFinished||!Array.isArray(review.payouts))return null;
  const roster=(body.horses??[]).map((h:any)=>h.number).sort((a:number,b:number)=>a-b).join("-");
  const finishes=(review.finishers??[]).filter((h:any)=>h.finish>0).map((h:any)=>h.finish);
  if(body.scratched?.length||row.payload.roster!==roster||new Set(finishes).size!==finishes.length)return {settlement_status:"excluded",return_yen:null};
  if(![1,2,3].every(n=>finishes.includes(n)))return null;
  const name:Record<string,string>={win:"単勝",bracket_quinella:"枠連",quinella:"馬連",trio:"三連複"};
  const label=(s:string)=>s.normalize("NFKC").replace(/\s/g,"").replace("3連複","三連複").replace("枠連複","枠連").replace("枠複","枠連").replace("馬連複","馬連");
  const pays=review.payouts.filter((p:any)=>label(p.type??"")===name[row.payload.bet]&&Number.isFinite(p.payout)&&p.payout>0);
  // Missing payout for this market is never settled as a losing ticket.
  if(!pays.length)return null;
  const key=(s:string)=>[...(s.normalize("NFKC").match(/\d+/g)??[])].map(Number).sort((a,b)=>a-b).join("-");
  const price=new Map<string,number>();for(const p of pays){const k=key(p.selection??"");if(!k||price.has(k))return null;price.set(k,p.payout);}
  const ret=row.payload.selections.reduce((sum:number,q:any)=>sum+(price.get([...q.numbers].sort((a:number,b:number)=>a-b).join("-"))??0),0);
  return {settlement_status:"settled",return_yen:ret};
}
