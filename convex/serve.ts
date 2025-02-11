import { v } from "convex/values";
import { MessageContent } from "openai/resources/beta/threads/messages";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/index";
import {
  action,
  ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { asyncMap, asyncSleep } from "modern-async";

const OPENAI_MODEL = "gpt-3.5-turbo";
const MAX_TOKENS = 4000; // Adjust based on your GPT model's limit

function truncateText(text: string): string {
  // Rough approximation: 1 token ≈ 4 characters
  const maxChars = MAX_TOKENS * 4;
  if (text.length <= maxChars) {
    console.log("In the token range");
    return text;
  }

  // Take first and last portions of the text
  const halfLength = Math.floor(maxChars / 2);
  const firstHalf = text.slice(0, halfLength);
  const secondHalf = text.slice(-halfLength);

  return `${firstHalf}\n\n[...Content truncated for length...]\n\n${secondHalf}`;
}

async function embedTexts(text: string) {
  if (!text) return [];

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const { data } = await openai.embeddings.create({
    input: text,
    model: "text-embedding-ada-002",
  });

  return data.map(({ embedding }) => embedding);
}

export const answer = internalAction({
  args: {
    sessionId: v.string(),
  },
  handler: async (ctx, { sessionId }) => {
    const messages = await ctx.runQuery(internal.serve.getMessages, {
      sessionId,
    });
    const lastUserMessage = messages.at(-1)!.text;

    const [embedding] = await embedTexts(lastUserMessage);

    const searchResults = await ctx.vectorSearch("calcrim", "by_embedding", {
      vector: embedding,
      limit: 8,
    });

    const relevantDocuments = await ctx.runQuery(internal.serve.getChunks, {
      embeddingIds: searchResults.map(({ _id }) => _id),
    });

    const messageId = await ctx.runMutation(internal.serve.addBotMessage, {
      sessionId,
    });

    try {
      const openai = new OpenAI();
      const stream = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        stream: true,
        messages: [
          {
            role: "system",
            content: `
                You are an expert in criminal law and legal writing, specializing in evaluating probable cause declarations for warrantless arrests or warrants. 
    - Your task is to review probable cause declarations to ensure they meet legal standards, including adherence to statutory and constitutional requirements.
    - Identify and correct any errors, such as insufficient factual basis, missing legal elements, or lack of specificity.
    - Highlight and fix grammar, spelling, and structural issues to ensure clarity and professionalism.
    - Suggest improvements to strengthen the declaration and ensure legal compliance.
    - When requested, generate examples of properly written probable cause declarations for training or demonstration purposes.
    - Ensure all advice and recommendations are clear, actionable, and legally sound.
            `,
          },
          ...(relevantDocuments.map((v) => ({
            role: "system",
            content: "Relevant document:\n\n" + v?.text,
          })) as ChatCompletionMessageParam[]),
          ...(messages.map(({ isViewer, text }) => ({
            role: isViewer ? "user" : "assistant",
            content: text,
          })) as ChatCompletionMessageParam[]),
        ],
      });
      let text = "";
      for await (const { choices } of stream) {
        const replyDelta = choices[0].delta.content;
        if (typeof replyDelta === "string" && replyDelta.length > 0) {
          text += replyDelta;
          await ctx.runMutation(internal.serve.updateBotMessage, {
            messageId,
            text,
          });
        }
      }
    } catch (error: any) {
      await ctx.runMutation(internal.serve.updateBotMessage, {
        messageId,
        text: "I cannot reply at this time. Reach out to the team on Discord",
      });
      throw error;
    }
  },
});

export const getMessages = internalQuery(
  async (ctx, { sessionId }: { sessionId: string }) => {
    return await ctx.db
      .query("messages")
      .withIndex("bySessionId", (q) => q.eq("sessionId", sessionId))
      .collect();
  }
);

export const getChunks = internalQuery(
  async (ctx, { embeddingIds }: { embeddingIds: Id<"calcrim">[] }) => {
    const chunks = embeddingIds.map((id) => ctx.db.get(id));

    return await Promise.all(chunks);
  }
);

export const addBotMessage = internalMutation(
  async (ctx, { sessionId }: { sessionId: string }) => {
    return await ctx.db.insert("messages", {
      isViewer: false,
      text: "",
      sessionId,
    });
  }
);

export const updateBotMessage = internalMutation(
  async (
    ctx,
    { messageId, text }: { messageId: Id<"messages">; text: string }
  ) => {
    await ctx.db.patch(messageId, { text });
  }
);

// crimne element
export const crimeElement = action({
  args: {
    pcId: v.id("pc"),
  },
  handler: async (ctx, args): Promise<Doc<"crimeElement">> => {
    const pc_element = (await ctx.runQuery(
      internal.serve.getCrimeElementByPcId,
      {
        pcId: args.pcId,
      }
    )) as Doc<"crimeElement">;

    if (!pc_element) {
      const id = await ctx.runAction(internal.serve.generateCrimeElement, {
        pcId: args.pcId,
      });

      const data = await ctx.runQuery(internal.serve.getCrimeElement, {
        id,
      });
      if (!data) throw new Error("No data");
      return data;
    }

    return pc_element;
  },
});

export const generateCrimeElement = internalAction({
  args: {
    pcId: v.id("pc"),
  },
  handler: async (ctx, args): Promise<Id<"crimeElement">> => {
    const pc = await ctx.runQuery(internal.serve.getPc, { pcId: args.pcId });
    if (!pc) throw new Error("PC not found");

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const [embedding] = await embedTexts(pc.code_number + " " + pc.narrative);
    const searchResults = await ctx.vectorSearch("calcrim", "by_embedding", {
      vector: embedding,
      limit: 5,
    });
    const relevantDocuments = await ctx.runQuery(internal.serve.getChunks, {
      embeddingIds: searchResults.map(({ _id }) => _id),
    });

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,

      messages: [
        {
          role: "system",
          content: `You are a legal expert. Given a criminal code, provide:
          1. A list of elements required to prove the crime
          2. The CALCRIM jury instruction example
          
          Format your response exactly as a JSON object with two arrays:
          {
            "elements": ["element1", "element2", ...],
            "calcrim_example": ["instruction1", "instruction2", ...]
          }`,
        },
        ...(relevantDocuments.map((v) => ({
          role: "system",
          content: "Relevant document:\n\n" + v?.text,
        })) as ChatCompletionMessageParam[]),
        {
          role: "user",
          content: `Create elements and CALCRIM example for: ${pc.code_number} - ${pc.narrative}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error("No response content");

    const result = JSON.parse(content);

    return await ctx.runMutation(internal.serve.createCrimeElement, {
      pcId: args.pcId,
      elements: result.elements,
      calcrimExample: result.calcrim_example,
    });
  },
});

export const createCrimeElement = internalMutation({
  args: {
    pcId: v.id("pc"),
    elements: v.array(v.string()),
    calcrimExample: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("crimeElement", {
      pcId: args.pcId,
      element: args.elements,
      calcrim_example: args.calcrimExample,
    });
  },
});

export const getPc = internalQuery({
  args: {
    pcId: v.id("pc"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.pcId);
  },
});

export const getCrimeElementByPcId = internalQuery({
  args: {
    pcId: v.id("pc"),
  },
  handler: async (ctx, args): Promise<Doc<"crimeElement"> | null> => {
    const pc_element = await ctx.db
      .query("crimeElement")
      .withIndex("by_pcId", (q) => q.eq("pcId", args.pcId))
      .first();
    return pc_element;
  },
});

export const getCrimeElement = internalQuery({
  args: {
    id: v.id("crimeElement"),
  },
  handler: async (ctx, { id }) => {
    return ctx.db.get(id);
  },
});

// Add this type for structured analysis results
export interface ReportAnalysis {
  documentationAnalysis: {
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
  };
  legalElements: {
    satisfiedElements: string[];
    missingElements: string[];
    recommendations: string[];
  };
  investigativeQuality: {
    completedSteps: string[];
    missingSteps: string[];
    recommendations: string[];
  };
  courtPreparation: {
    strengths: string[];
    vulnerabilities: string[];
    recommendations: string[];
  };
  overallAssessment: {
    reportScore: number;
    primaryIssues: string[];
    nextSteps: string[];
  };
}

export const validateReport = action({
  args: {
    bookingFormId: v.optional(v.id("booking")),
    selectedCodes: v.optional(v.array(v.any())),
    reportText: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ReportAnalysis> => {
    let data;
    if (args.bookingFormId) {
      data = await ctx.runQuery(internal.serve.getFormData, {
        id: args.bookingFormId,
      });
    }
    const openai = new OpenAI();

    const reportText = args.reportText
      ? truncateText(args.reportText)
      : undefined;

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a law enforcement report analysis and writing assistant specializing in analyzing police reports. Evaluate reports based on these key areas:

1. DOCUMENTATION ANALYSIS
- Evidence completeness and chain of custody
- Chronological clarity and timeline accuracy
- Proper documentation of dates, times, locations
- Body camera footage documentation
- Digital evidence handling
- Physical evidence processing
- Interview/statement documentation

2. LEGAL ELEMENTS
- Penal code element satisfaction
- Probable cause establishment
- Search/seizure compliance
- Miranda rights documentation
- Constitutional considerations
- Statute of limitations
- Jurisdiction verification

3. INVESTIGATIVE THOROUGHNESS
- Witness identification and statements
- Follow-up actions documented
- Evidence collection methods
- Investigative steps taken
- Officer observations
- Scene documentation
- Technical analysis results

4. COURT PREPARATION
- Evidence strength assessment
- Potential defense challenges
- Witness credibility factors
- Constitutional issues
- Procedural compliance
- Documentation gaps
- Expert testimony needs

Provide a structured JSON response:
{
  "documentationAnalysis": {
    "strengths": ["list of strong points"],
    "weaknesses": ["list of weak points"],
    "recommendations": ["specific improvements"]
  },
  "legalElements": {
    "satisfiedElements": ["elements met"],
    "missingElements": ["elements not met"],
    "recommendations": ["specific improvements"]
  },
  "investigativeQuality": {
    "completedSteps": ["steps taken"],
    "missingSteps": ["steps needed"],
    "recommendations": ["specific improvements"]
  },
  "courtPreparation": {
    "strengths": ["strong points"],
    "vulnerabilities": ["weak points"],
    "recommendations": ["specific improvements"]
  },
  "overallAssessment": {
    "reportScore": "1-10 rating",
    "primaryIssues": ["critical issues"],
    "nextSteps": ["immediate actions needed"]
  }
}`,
        },
        {
          role: "user",
          content: `Analyze this case with the following context:
      ${args.selectedCodes ? `PENAL CODES: ${JSON.stringify(args.selectedCodes, null, 2)}` : ""}
      ${data ? `PROBABLE CAUSE AND ADDITIONAL INFO: ${JSON.stringify(data, null, 2)}` : ""}
      ${reportText ? `REPORT TEXT: ${reportText}` : ""}`,
        },
      ],
      temperature: 0.7,
    });
    const content = response.choices[0].message.content;
    if (!content) throw new Error("no conten is created");

    return JSON.parse(content) as ReportAnalysis;
  },
});

export const suggestImprovements = action({
  args: {
    bookingFormId: v.optional(v.id("booking")),
    selectedCodes: v.optional(v.array(v.any())),
    reportText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // let data;
    // if (args.bookingFormId) {
    //   data = await ctx.runQuery(internal.serve.getFormData, {
    //     id: args.bookingFormId,
    //   });
    // }
    const openai = new OpenAI();

    const reportText = args.reportText
      ? truncateText(args.reportText)
      : undefined;

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a law enforcement report analysis and writing assistant. Your role is to help analyze, improve, and generate detailed police reports following standard law enforcement documentation protocols. When presented with a report or case details:

Instructions for Generating a Narrative Incident Report with Detailed Notification Section

Objective: Generate a narrative-style incident report for any penal code violation, ensuring the Notification section includes specific details about the incident's time, location, and initial response.

Structure of the Report:

    Headers:
        File Number
        Penal Code Violation (e.g., Penal Code 488 - Petty Theft)
        Date and Time of Incident
        Location of Incident

    Notification:
        Include specific details based on the provided example:
            Mention the jurisdiction (e.g., Riverside County, California).
            Provide a timestamp for dispatch and arrival.
            Specify the officer's status during the incident (e.g., uniformed patrol).
            Include the location, call origin (e.g., manager or witness), and any immediate findings or conditions upon arrival.

Example Format for Notification:

All events mentioned occurred in Riverside County, California.

On [Date] at [Time, e.g., 16:54 hours], while on uniformed patrol duty in [Location, e.g., Palm Desert, Riverside County], I was dispatched to a reported [Incident Type, e.g., petty theft] at [Business Name and Address, e.g., Mike's Smoke Shop, 73520 Highway 111, Palm Desert, California]. The call was placed by [Caller, e.g., the store manager, Mohammad Manasra]. I arrived on scene at [Time, e.g., 16:58 hours], and this account summarizes the incident, which involved [Initial Findings, e.g., two male suspects who were gone on arrival]. The following is a summary of the incident:

    EVIDENCE: Describe evidence collected, using narrative form:
        Specify items, their descriptions, and where they were uploaded or stored (e.g., evidence.com).

    BODY-WORN CAMERA: Mention whether the body-worn camera (BWC) was used and how footage was managed (e.g., "uploaded to evidence.com").

    DETAILS: Provide a chronological account of events:
        Arrival, actions taken, interviews conducted, and findings.

    CONCLUSION: Summarize findings and state the case status (e.g., suspended, open, closed, pending).

    CASE STATUS: Clearly indicate the case status.`,
        },
        {
          role: "user",
          content: `Suggest improvements for this case:
          ${args.selectedCodes ? `Penal Codes: ${JSON.stringify(args.selectedCodes, null, 2)}` : ""}
          ${reportText ? `Current Report: ${reportText}` : ""}`,
        },
      ],
    });

    return response.choices[0].message.content;
  },
});

export const generateExample = action({
  args: {
    selectedCodes: v.optional(v.array(v.any())),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const openai = new OpenAI();

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `You are an experienced police report writing instructor. Generate a model police report that demonstrates:

Instructions for Generating a Narrative Incident Report with Detailed Notification Section

Objective: Generate a narrative-style incident report for any penal code violation, ensuring the Notification section includes specific details about the incident's time, location, and initial response.

Structure of the Report:

    Headers:
        File Number
        Penal Code Violation (e.g., Penal Code 488 - Petty Theft)
        Date and Time of Incident
        Location of Incident

    Notification:
        Include specific details based on the provided example:
            Mention the jurisdiction (e.g., Riverside County, California).
            Provide a timestamp for dispatch and arrival.
            Specify the officer's status during the incident (e.g., uniformed patrol).
            Include the location, call origin (e.g., manager or witness), and any immediate findings or conditions upon arrival.

Example Format for Notification:

All events mentioned occurred in Riverside County, California.

On [Date] at [Time, e.g., 16:54 hours], while on uniformed patrol duty in [Location, e.g., Palm Desert, Riverside County], I was dispatched to a reported [Incident Type, e.g., petty theft] at [Business Name and Address, e.g., Mike's Smoke Shop, 73520 Highway 111, Palm Desert, California]. The call was placed by [Caller, e.g., the store manager, Mohammad Manasra]. I arrived on scene at [Time, e.g., 16:58 hours], and this account summarizes the incident, which involved [Initial Findings, e.g., two male suspects who were gone on arrival]. The following is a summary of the incident:

    EVIDENCE: Describe evidence collected, using narrative form:
        Specify items, their descriptions, and where they were uploaded or stored (e.g., evidence.com).

    BODY-WORN CAMERA: Mention whether the body-worn camera (BWC) was used and how footage was managed (e.g., "uploaded to evidence.com").

    DETAILS: Provide a chronological account of events:
        Arrival, actions taken, interviews conducted, and findings.

    CONCLUSION: Summarize findings and state the case status (e.g., suspended, open, closed, pending).

    CASE STATUS: Clearly indicate the case status.

          Create a realistic police report that would stand up to court scrutiny.`,
        },
        {
          role: "user",
          content: `Generate an example report based on these penal codes:
          ${JSON.stringify(args.selectedCodes, null, 2)}
          ${args.text && args.text.length > 2 ? `And with the base report ${JSON.stringify(args.text, null, 2)}` : ""}
          `,
        },
      ],
    });

    return response.choices[0].message.content;
  },
});

export const getFormData = internalQuery({
  args: {
    id: v.id("booking"),
  },
  handler: async (ctx, { id }) => {
    const booking_form_data = await ctx.db.get(id);
    let cause_form_data: Doc<"cause"> | null = null;
    if (booking_form_data && booking_form_data.causeId) {
      cause_form_data = await ctx.db.get(booking_form_data.causeId);
    }

    return cause_form_data?.data;
  },
});

export const correction = action({
  args: {
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const openai = new OpenAI();
    const { id: threadId } = await openai.beta.threads.create();
    const { id: lastMessageId } = await openai.beta.threads.messages.create(
      threadId,
      { role: "user", content: args.text }
    );
    const { id: runId } = await openai.beta.threads.runs.create(threadId, {
      assistant_id: "asst_pfDzxmL51GKm971oOMWR4w83", //TODO: Later have to change this to env or something
    });

    const data = await pollForAnswer(ctx, {
      runId,
      threadId,
      lastMessageId,
    });

    return data;
  },
});

async function pollForAnswer(
  ctx: ActionCtx,
  args: {
    threadId: string;
    runId: string;
    lastMessageId: string;
  }
) {
  const { threadId, runId, lastMessageId } = args;
  const openai = new OpenAI();
  while (true) {
    await asyncSleep(500);
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    switch (run.status) {
      case "failed":
      case "expired":
      case "cancelled":
        return "I cannot reply at this time. Reach out to the team on Discord";
      case "completed": {
        const { data: newMessages } = await openai.beta.threads.messages.list(
          threadId,
          { after: lastMessageId, order: "asc" }
        );
        return newMessages;
      }
    }
  }
}
