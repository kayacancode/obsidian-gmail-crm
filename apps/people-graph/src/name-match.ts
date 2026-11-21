/**
 * Name matching shared with the Rust CLI's local `find-person` (crates/peoplegraph/src/main.rs:
 * `match_confidence`, `name_hints`), so hosted and local answers label and rank names the same way.
 */
export type NameMatchKind='exact'|'reordered'|'partial'|'fuzzy';

/** ASCII-lowercase, every other character a separator, single spaces. */
export function normalizeName(value:string){
 return value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
const tokenKey=(value:string)=>normalizeName(value).split(' ').filter(Boolean).sort().join(' ');
/** True when every token of `needle` appears contiguously, as whole tokens, in `haystack`. */
function containsTokenRun(haystack:string,needle:string){
 const hay=haystack.split(' ').filter(Boolean),need=needle.split(' ').filter(Boolean);
 if(!need.length||need.length>hay.length)return false;
 for(let i=0;i+need.length<=hay.length;i++)if(need.every((t,j)=>hay[i+j]===t))return true;
 return false;
}

/** Jaro-Winkler similarity (prefix up to 4, scaling 0.1), as in the `strsim` crate. */
export function jaroWinkler(a:string,b:string){
 if(a===b)return 1;
 const al=[...a],bl=[...b];
 if(!al.length||!bl.length)return 0;
 const window=Math.max(0,Math.floor(Math.max(al.length,bl.length)/2)-1);
 const aHit=new Array<boolean>(al.length).fill(false),bHit=new Array<boolean>(bl.length).fill(false);
 let matches=0;
 for(let i=0;i<al.length;i++){
  for(let j=Math.max(0,i-window);j<Math.min(bl.length,i+window+1);j++){
   if(bHit[j]||al[i]!==bl[j])continue;
   aHit[i]=bHit[j]=true;matches++;break;
  }
 }
 if(!matches)return 0;
 let transpositions=0,k=0;
 for(let i=0;i<al.length;i++){
  if(!aHit[i])continue;
  while(!bHit[k])k++;
  if(al[i]!==bl[k])transpositions++;
  k++;
 }
 const jaro=(matches/al.length+matches/bl.length+(matches-transpositions/2)/matches)/3;
 let prefix=0;while(prefix<4&&prefix<al.length&&prefix<bl.length&&al[prefix]===bl[prefix])prefix++;
 return jaro+0.1*prefix*(1-jaro);
}

/** How well a person's name matches a (non-email) query, or null below the fuzzy threshold. */
export function nameMatch(name:string,query:string,strictOrder:boolean):{confidence:number;kind:NameMatchKind}|null{
 const n=normalizeName(name),q=normalizeName(query);
 if(!n||!q)return null;
 if(n===q)return {confidence:0.99,kind:'exact'};
 if(!strictOrder&&tokenKey(name)===tokenKey(query))return {confidence:0.91,kind:'reordered'};
 if(containsTokenRun(n,q))return {confidence:0.90,kind:'partial'};
 if(n.length>=4&&containsTokenRun(q,n))return {confidence:0.86,kind:'partial'};
 const score=jaroWinkler(n,q);
 return score>0.84?{confidence:score,kind:'fuzzy'}:null;
}
/** Matches kept for a query: at least this confident. */
export const NAME_MATCH_FLOOR=0.72;

/** Up to three names close to the query (by whole name or any one name token), best first. */
export function nearestNames(names:string[],query:string){
 const q=normalizeName(query);if(!q)return [];
 const seen=new Set<string>(),scored:[number,string][]=[];
 for(const display of names){
  const key=normalizeName(display);
  if(!key||seen.has(key))continue;
  seen.add(key);
  const value=Math.max(jaroWinkler(key,q),...key.split(' ').map(t=>jaroWinkler(t,q)));
  if(value>=0.80)scored.push([value,display]);
 }
 return scored.sort((a,b)=>b[0]-a[0]||a[1].localeCompare(b[1])).slice(0,3).map(([,display])=>display);
}
