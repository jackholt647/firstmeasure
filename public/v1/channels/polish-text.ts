import { randomBytes } from 'node:crypto';
import { badRequest } from '../platform/errors.js';

export function protectPolishText(text:string,names:string[]){
 const replacements=new Map<string,string>(),prefix='[[FM_POLISH_'+randomBytes(8).toString('hex')+'_';
 const protect=(value:string)=>{const token=prefix+replacements.size+']]';replacements.set(token,value);return token;};
 let protectedText=text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`|(?:^\|[^\n]*(?:\n|$))+(?:<!--fm-table-widths:[^>]+-->\n?)?/gm,protect);
 protectedText=protectedText.replace(/https?:\/\/[^\s)<>]+|www\.[^\s)<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,protect);
 for(const name of [...new Set(names)].sort((a,b)=>b.length-a.length)){const literal='@'+name;protectedText=protectedText.split(literal).map((part,index)=>(index?protect(literal):'')+part).join('');}
 protectedText=protectedText.replace(/\b\d+(?:[.,]\d+)*(?:%|\b)/g,protect);
 const tokenPattern=new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\d+\\]\\]','g'),expected=protectedText.match(tokenPattern) || [];
 return {text:protectedText,restore(output:string){const tokens=output.match(tokenPattern) || [];if(JSON.stringify(tokens)!==JSON.stringify(expected))throw badRequest('polish_references_changed','The polish could not preserve your draft. Your original text is unchanged.');let restored=output;for(const [token,value] of replacements)restored=restored.split(token).join(value);return restored;}};
}
