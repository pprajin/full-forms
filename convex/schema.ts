import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { createArrestDeclaration } from "./mutation";

export default defineSchema({
  crimeElement: defineTable({
    pcId: v.id("pc"),
    element: v.array(v.string()),
    calcrim_example: v.array(v.string()),
  }).index("by_pcId", ["pcId"]),

  // CODE #,CODE TYPE,NARRATIVE,M/F
  pc: defineTable({
    code_number: v.string(),
    codeType: v.string(),
    narrative: v.string(),
    m_f: v.union(v.literal("M"), v.literal("F")),
  })
    .searchIndex("search_narrative", {
      searchField: "narrative",
      filterFields: ["code_number"],
    })
    .searchIndex("search_code_number", {
      searchField: "code_number",
    }),
  booking: defineTable({
    data: v.any(),
    charges: v.array(v.any()),
    causeId: v.optional(v.id("cause")),
  }),
  cause: defineTable({
    data: v.any(),
    isFirstMsgId: v.optional(v.id("messages")),
  }),
  arrestDeclaration: defineTable({
    data: v.any(),
  }),
  calcrim: defineTable({
    text: v.string(),
    embedding: v.array(v.number()),
  }).vectorIndex("by_embedding", {
    dimensions: 1536,
    vectorField: "embedding",
  }),

  messages: defineTable({
    isViewer: v.boolean(),
    sessionId: v.string(),
    text: v.string(),
  }).index("bySessionId", ["sessionId"]),
  signature: defineTable({
    base64Sign: v.string(),
    userName: v.string(),
  }),
});
