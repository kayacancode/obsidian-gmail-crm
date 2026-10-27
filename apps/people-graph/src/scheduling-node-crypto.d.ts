// The Worker enables nodejs_compat. Keep this one used API typed without adding
// Node's global fetch/Request declarations to the Cloudflare runtime types.
declare module 'node:crypto' {
 export function verify(algorithm:'sha256',data:Uint8Array,key:string,signature:Uint8Array):boolean;
}
