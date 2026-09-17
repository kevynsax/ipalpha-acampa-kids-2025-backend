import { config } from "../config";
import type { AiVendor } from "../routes/ai";

/** Final import-worker pass: normalizes only the campers' general observations. */
export const OBSERVATION_NORMALIZE_MODEL={id:"glm-5.3-flash",label:"GLM 5.3 Flash",vendor:"zhipu" as AiVendor};
const MAX_CHARS=4_000,TIMEOUT_MS=20_000;
const SYSTEM=`Você normaliza APENAS o campo Observações da ficha de uma criança em um acampamento infantil brasileiro.

Corrija ortografia, acentuação, pontuação, espaços e separadores. Organize assuntos diferentes em frases curtas ou linhas separadas. Preserve TODAS as informações, nomes, números, telefones e instruções. Não resuma, não invente, não remova, não mova informações para outros campos e não acrescente títulos.

Responda somente JSON: {"value":"texto normalizado"}.`;

export interface ObservationNormalizeResult{value:string;ok:boolean;model:string;vendor:AiVendor;usage:{promptTokens:number;completionTokens:number};error?:string}

export async function normalizeCamperObservations(value:string,signal?:AbortSignal):Promise<ObservationNormalizeResult>{
 const input=value.trim().slice(0,MAX_CHARS),usage={promptTokens:0,completionTokens:0};
 if(!input||!config.ai.apiKey)return{value,ok:true,model:OBSERVATION_NORMALIZE_MODEL.id,vendor:OBSERVATION_NORMALIZE_MODEL.vendor,usage};
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),TIMEOUT_MS),onAbort=()=>ctrl.abort();signal?.addEventListener("abort",onAbort);
 try{const res=await fetch(`${config.ai.baseUrl}/chat/completions`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${config.ai.apiKey}`},body:JSON.stringify({model:OBSERVATION_NORMALIZE_MODEL.id,temperature:0,reasoning_effort:"low",response_format:{type:"json_object"},messages:[{role:"system",content:SYSTEM},{role:"user",content:input}]}),signal:ctrl.signal});
  const data=await res.json().catch(()=>null) as {choices?:{message?:{content?:string}}[];usage?:{prompt_tokens?:number;completion_tokens?:number}}|null;usage.promptTokens=data?.usage?.prompt_tokens??0;usage.completionTokens=data?.usage?.completion_tokens??0;if(!res.ok)return{value,ok:false,model:OBSERVATION_NORMALIZE_MODEL.id,vendor:OBSERVATION_NORMALIZE_MODEL.vendor,usage,error:`HTTP ${res.status}`};
  const content=(data?.choices?.[0]?.message?.content??"").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");const start=content.indexOf("{"),end=content.lastIndexOf("}");if(start<0||end<start)return{value,ok:false,model:OBSERVATION_NORMALIZE_MODEL.id,vendor:OBSERVATION_NORMALIZE_MODEL.vendor,usage,error:"Resposta sem JSON"};
  const parsed=JSON.parse(content.slice(start,end+1)) as Record<string,unknown>,next=typeof parsed.value==="string"?parsed.value.trim().slice(0,MAX_CHARS):"";return next?{value:next,ok:true,model:OBSERVATION_NORMALIZE_MODEL.id,vendor:OBSERVATION_NORMALIZE_MODEL.vendor,usage}:{value,ok:false,model:OBSERVATION_NORMALIZE_MODEL.id,vendor:OBSERVATION_NORMALIZE_MODEL.vendor,usage,error:"Valor vazio"};
 }catch(error){return{value,ok:false,model:OBSERVATION_NORMALIZE_MODEL.id,vendor:OBSERVATION_NORMALIZE_MODEL.vendor,usage,error:error instanceof Error?error.message:"Falha"};}finally{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);}
}
