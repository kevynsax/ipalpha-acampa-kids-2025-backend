import {describe,expect,test} from "bun:test";
import {normalizeCamperObservations,OBSERVATION_NORMALIZE_MODEL} from "./observationNormalizeAi";

describe("observation normalization AI",()=>{
 test("uses GLM 5.3 Flash",()=>{expect(OBSERVATION_NORMALIZE_MODEL.id).toBe("glm-5.3-flash")});
 test("leaves empty observations empty without a request",async()=>{const result=await normalizeCamperObservations("  ");expect(result.value).toBe("  ");expect(result.ok).toBe(true)});
});
