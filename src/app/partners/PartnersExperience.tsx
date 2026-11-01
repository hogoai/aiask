"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, BrainCircuit, CalendarDays, Check, ChartNoAxesCombined, ChevronDown, Compass, Lightbulb, MessageCircleQuestion, Sparkles, Target, X } from "lucide-react";
import SiteNavigation from "../SiteNavigation";
import MarkdownContent from "./MarkdownContent";
import FollowUpComposer from "./FollowUpComposer";
import { isPartnerResponse, type ConversationMessage } from "../../lib/ai/conversations";
import { PARTNER_ROLE_ID, validateAIASKOutput, type PartnerResponse, type PartnerRole } from "../../lib/ai/contracts";
import "./partners.css";

type SavedIdea = { id: string; text: string; createdAt: string; status?: "Saved" | "In progress" | "Done" };
type AIUsage = { model: string; totalTokens: number | null };
type FollowUpMessage = { role: "user" | "assistant"; content: string };
type ConversationSaveStatus = "idle" | "saving" | "saved" | "failed";
type PendingReply =
  | { kind: "structured_response"; result: PartnerResponse; model: string; usage?: Record<string, unknown> }
  | { kind: "follow_up"; answer: string; model: string; usage?: Record<string, unknown> };
type FailedRequest = { partnerId: PartnerId; kind: "structured_response" | "follow_up"; conversationId: string; userMessageId: string; question: string };
type PartnerId = PartnerRole;
type Partner = {
  id: PartnerId;
  name: string;
  chinese: string;
  icon: typeof Compass;
  color: string;
  description: string;
  thinkingStyle: string;
  lens: string;
  perspective: (idea: string) => string;
  questions: (idea: string) => string[];
  watchFor: (idea: string) => string;
  nextStep: (idea: string) => string;
  tone: string;
};

const partners: Partner[] = [
  {
    id: PARTNER_ROLE_ID.guide, name: "AI Guide", chinese: "引导者", icon: MessageCircleQuestion, color: "sage",
    description: "Helps you find the real question inside the first one.", thinkingStyle: "Curious, clarifying, and patient. The Guide makes space for what is not yet fully formed.", lens: "Clarify the intention",
    perspective: idea => `Before acting on “${idea},” it may help to name what you hope will be different. A clearer intention can make the next choice feel lighter.`,
    questions: idea => [`What would a useful outcome for “${idea}” look like to you?`, "Why does this matter now?", "What feels most unclear or difficult to say out loud?"],
    watchFor: () => "A solution can arrive before the actual need is clear. Pause long enough to check whether the goal is yours, specific, and still relevant.",
    nextStep: idea => `Write one sentence about what you want to be different with “${idea}.” Keep it in your own words.`,
    tone: "I’ll ask before I assume.",
  },
  {
    id: PARTNER_ROLE_ID.planner, name: "AI Planner", chinese: "规划师", icon: CalendarDays, color: "clay",
    description: "Turns a desired outcome into a realistic sequence of steps.", thinkingStyle: "Practical and sequence-minded. The Planner looks for dependencies, a workable first milestone, and a pace that leaves breathing room.", lens: "Shape a workable path",
    perspective: idea => `Treat “${idea}” as a direction, not a to-do list. Start with one small milestone, then identify only the actions that unlock it.`,
    questions: idea => ["What is the first visible milestone?", "Which step depends on another person, resource, or decision?", "How much time would feel realistic this week?"],
    watchFor: () => "A detailed plan can feel productive while hiding too much scope. Keep the first plan short and leave room to revise it when reality gives you new information.",
    nextStep: idea => `Choose one milestone for “${idea}” and list the first action that would move it forward.`,
    tone: "Small steps, honest timing.",
  },
  {
    id: PARTNER_ROLE_ID.knowledgePartner, name: "AI Knowledge Specialist", chinese: "知识专员", icon: BrainCircuit, color: "blue",
    description: "Understand more. Think deeper. Decide better.", thinkingStyle: "Educational, practical, and evidence-conscious. The Knowledge Specialist explains relevant concepts and industry context, connects useful ideas, and marks what remains uncertain.", lens: "Build knowledge and evidence",
    perspective: idea => `For “${idea},” map the relevant concepts and evidence needed to understand it. No live research or personal notes are included in this demonstration.`,
    questions: idea => [`What experience or notes do you already have about “${idea}”?`, "Which terms or claims need a definition?", "What would be a trustworthy source for the missing context?"],
    watchFor: () => "A plausible connection is not proof. Until sources or your own notes are reviewed, treat new connections as questions to check rather than established facts.",
    nextStep: idea => `Make two short lists for “${idea}”: what you know from experience, and what you would want to verify.`,
    tone: "Curious, but careful with evidence.",
  },
  {
    id: PARTNER_ROLE_ID.evaluator, name: "AI Evaluator", chinese: "评估者", icon: ChartNoAxesCombined, color: "gold",
    description: "Defines what progress would look like and checks it fairly.", thinkingStyle: "Evidence-oriented and balanced. The Evaluator separates activity from outcomes, then looks for a fair signal and a chance to adjust.", lens: "Make progress observable",
    perspective: idea => `For “${idea},” decide what you could observe that would count as progress. Without a starting point or a signal, it is easy to confuse effort with results.`,
    questions: idea => ["What is one observable sign that “${idea}” is moving forward?", "What do you know about the starting point?", "When would you review the result and decide whether to adjust?"],
    watchFor: () => "A convenient metric may not reflect what matters. Pair any number with a short explanation of quality, impact, or what you learned.",
    nextStep: idea => `Pick one progress signal for “${idea}” and a date to check whether it is telling you something useful.`,
    tone: "Fair questions. No scorekeeping for its own sake.",
  },
  {
    id: PARTNER_ROLE_ID.advisor, name: "AI Advisor", chinese: "顾问", icon: Compass, color: "plum",
    description: "Surfaces alternatives, trade-offs, and a reasoned recommendation.", thinkingStyle: "Independent and comparative. The Advisor keeps more than one path in view and makes trade-offs explicit before suggesting a direction.", lens: "Compare paths and trade-offs",
    perspective: idea => `For “${idea},” compare a small reversible experiment with a larger commitment. Consider effort, what each path could teach you, and what would be hard to undo.`,
    questions: idea => ["What are two plausible ways to approach “${idea}”?", "Which choice is easiest to reverse if you learn something new?", "What value or constraint should guide the recommendation?"],
    watchFor: () => "A confident recommendation without your priorities is only a guess. Name what matters most and check the assumptions behind each option before choosing.",
    nextStep: idea => `Write down two options for “${idea}” and one trade-off you would accept for each.`,
    tone: "Independent, reasoned, and open to being wrong.",
  },
  {
    id: PARTNER_ROLE_ID.actionPartner, name: "AI Action Coach", chinese: "行动教练", icon: Target, color: "green",
    description: "Helps you turn an intention into a manageable action you can start.", thinkingStyle: "Practical, encouraging, and autonomy-first. The Action Coach lowers starting friction, anticipates blockers, and helps you learn from what happens at the pace you choose.", lens: "Turn intention into action",
    perspective: idea => `For “${idea},” choose one small, visible action with a clear finish line. Make the first move easy enough to begin, then adjust based on what you learn.`,
    questions: idea => [`What is the smallest useful action you could begin for “${idea}”?`, "What is most likely to get in the way?", "What tool, time, or support would make starting easier for you?"],
    watchFor: () => "A first step should fit the user's real time and resources. If it depends on too many unknowns, shrink it to a small learning action or pause until the missing support is available.",
    nextStep: idea => `Choose one action for “${idea}” that you could start in about 15 minutes, and note its first visible move.`,
    tone: "Encouraging, concrete, and autonomy-first.",
  },
];

function getPartner(id: PartnerId | null) { return partners.find(partner => partner.id === id) ?? null; }

export default function PartnersExperience({ initialConversationId, initialPartnerId }: { initialConversationId?: string; initialPartnerId?: string }) {
  const [savedIdeas, setSavedIdeas] = useState<SavedIdea[]>([]);
  const [ideaText, setIdeaText] = useState("");
  const [selectedIdeaId, setSelectedIdeaId] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [activePartnerId, setActivePartnerId] = useState<PartnerId | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [followUpMessages, setFollowUpMessages] = useState<FollowUpMessage[]>([]);
  const [followUpUsage, setFollowUpUsage] = useState<AIUsage | null>(null);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState("");
  const [followUpNeedsSignIn, setFollowUpNeedsSignIn] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftPartnerId, setDraftPartnerId] = useState<PartnerId | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [liveResponse, setLiveResponse] = useState<PartnerResponse | null>(null);
  const [liveUsage, setLiveUsage] = useState<AIUsage | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState("");
  const [liveNeedsSignIn, setLiveNeedsSignIn] = useState(false);
  const [conversationIdsByPartner, setConversationIdsByPartner] = useState<Partial<Record<PartnerId, string>>>({});
  const [conversationSaveStatus, setConversationSaveStatus] = useState<ConversationSaveStatus>("idle");
  const [conversationStorageNeedsSetup, setConversationStorageNeedsSetup] = useState(false);
  const [pendingReply, setPendingReply] = useState<PendingReply | null>(null);
  const [failedRequest, setFailedRequest] = useState<FailedRequest | null>(null);
  const [conversationSaveError, setConversationSaveError] = useState("");
  const liveRequest = useRef<AbortController | null>(null);
  const followUpRequest = useRef<AbortController | null>(null);
  const resumeHandled = useRef(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("aiask-idea-box");
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((item): item is SavedIdea => item && typeof item.id === "string" && typeof item.text === "string" && typeof item.createdAt === "string");
          setSavedIdeas(valid);
          if (valid[0]) { setIdeaText(valid[0].text); setSelectedIdeaId(valid[0].id); }
        }
      }
    } catch {
      // The input remains available even if this browser cannot read the Idea Box.
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => () => {
    liveRequest.current?.abort();
    followUpRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (!storageReady || !initialConversationId || !initialPartnerId || resumeHandled.current) return;
    resumeHandled.current = true;
    const partnerId = initialPartnerId as PartnerId;
    setActivePartnerId(partnerId);
    setConversationIdsByPartner({ [partnerId]: initialConversationId });
    void loadPartnerConversation(partnerId, initialConversationId);
    window.requestAnimationFrame(() => document.getElementById("partner-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [storageReady, initialConversationId, initialPartnerId]);

  const activePartner = getPartner(activePartnerId);
  const ideaForDemo = useMemo(() => ideaText.trim() || "your idea", [ideaText]);
  const hasIdea = Boolean(ideaText.trim());
  const displayedUsage = followUpUsage || liveUsage;

  function selectSavedIdea(id: string) {
    clearLiveResponse();
    setConversationIdsByPartner({});
    const match = savedIdeas.find(idea => idea.id === id);
    setSelectedIdeaId(match ? match.id : "");
    setIdeaText(match ? match.text : "");
  }

  function clearLiveResponse() {
    liveRequest.current?.abort();
    liveRequest.current = null;
    clearFollowUp();
    setLiveResponse(null);
    setLiveUsage(null);
    setLiveError("");
    setLiveNeedsSignIn(false);
    setLiveLoading(false);
    setConversationSaveStatus("idle");
    setConversationStorageNeedsSetup(false);
    setConversationSaveError("");
    setPendingReply(null);
    setFailedRequest(null);
  }

  function clearFollowUp() {
    followUpRequest.current?.abort();
    followUpRequest.current = null;
    setFollowUpMessages([]);
    setFollowUpUsage(null);
    setFollowUpError("");
    setFollowUpNeedsSignIn(false);
    setFollowUpLoading(false);
    setFollowUp("");
  }

  function changeIdea(value: string) {
    clearLiveResponse();
    setConversationIdsByPartner({});
    setIdeaText(value);
    setSelectedIdeaId("");
  }

  async function generatePartnerResponse(partnerId: PartnerId, retryMessageId?: string) {
    const idea = ideaText.trim();
    if (!idea) {
      setLiveError("Add an idea above before asking the AI Team.");
      return;
    }

    liveRequest.current?.abort();
    const controller = new AbortController();
    liveRequest.current = controller;
    setLiveLoading(true);
    setLiveError("");
    setLiveNeedsSignIn(false);
    setLiveResponse(null);
    setLiveUsage(null);
    setConversationSaveStatus("saving");
    setConversationStorageNeedsSetup(false);
    setConversationSaveError("");
    setPendingReply(null);
    setFailedRequest(null);
    clearFollowUp();

    try {
      const conversationId = conversationIdsByPartner[partnerId];
      const response = await fetch("/api/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerRole: partnerId,
          userMessage: idea,
          ...(conversationId ? { conversationId } : {}),
          ...(retryMessageId ? { retryMessageId } : {}),
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const responsePayload = payload && typeof payload === "object" ? payload as {
          error?: { code?: string; message?: string };
          conversationId?: string;
          userMessageId?: string;
          historySaved?: boolean;
        } : {};
        const error = responsePayload.error;
        setLiveNeedsSignIn(error?.code === "sign_in_required");
        setConversationStorageNeedsSetup(error?.code === "conversation_storage_unavailable");
        if (responsePayload.conversationId) {
          setConversationIdsByPartner(current => ({ ...current, [partnerId]: responsePayload.conversationId }));
        }
        setConversationSaveStatus(responsePayload.historySaved ? "saved" : "idle");
        if (responsePayload.historySaved && responsePayload.conversationId && responsePayload.userMessageId) {
          setFailedRequest({ partnerId, kind: "structured_response", conversationId: responsePayload.conversationId, userMessageId: responsePayload.userMessageId, question: idea });
        }
        throw new Error(error?.message || "The AI Team role could not complete this request.");
      }

      const data = validateAIASKOutput(payload);
      if (!data || data.partnerRole !== partnerId || !data.result || !isPartnerResponse(data.result)) {
        throw new Error("The AI service returned an incomplete response. Please try again.");
      }
      const result = data.result;
      if (data.conversationId) setConversationIdsByPartner(current => ({ ...current, [partnerId]: data.conversationId }));
      setLiveResponse(result);
      const usage = data.usage;
      const model = data.model || "OpenAI";
      setLiveUsage({ model, totalTokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : null });
      if (data.saved === false) {
        setConversationSaveStatus("failed");
        setConversationSaveError("The AI answered, but the reply could not be saved.");
        setPendingReply({ kind: "structured_response", result, model, usage });
      } else {
        setConversationSaveStatus("saved");
        setConversationSaveError("");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setConversationSaveStatus(current => current === "saving" ? "idle" : current);
      setLiveError(error instanceof Error ? error.message : "The AI Team role could not complete this request.");
    } finally {
      if (liveRequest.current === controller) {
        liveRequest.current = null;
        setLiveLoading(false);
      }
    }
  }

  async function loadPartnerConversation(partnerId: PartnerId, conversationId: string) {
    setConversationSaveStatus("saving");
    setConversationStorageNeedsSetup(false);
    try {
      const response = await fetch("/api/ai/conversations/" + conversationId);
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" || !("conversation" in payload)) {
        throw new Error("This conversation could not be restored.");
      }
      const conversation = (payload as { conversation?: { messages?: ConversationMessage[] } }).conversation;
      const messages = conversation?.messages;
      if (!Array.isArray(messages)) throw new Error("This conversation has an invalid history.");
      const startingIdea = messages.find(message => message.kind === "idea")?.content;
      if (startingIdea) setIdeaText(startingIdea);

      const structuredMessages = messages.filter(message => message.role === "assistant" && message.kind === "structured_response");
      const latestStructured = structuredMessages[structuredMessages.length - 1];
      if (latestStructured && isPartnerResponse(latestStructured.metadata?.structuredResponse)) {
        setLiveResponse(latestStructured.metadata.structuredResponse);
        const usage = latestStructured.metadata.usage as { totalTokens?: unknown } | undefined;
        setLiveUsage({ model: typeof latestStructured.metadata.model === "string" ? latestStructured.metadata.model : "AI model", totalTokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : null });
      }

      setFollowUpMessages(messages
        .filter(message => message.kind === "follow_up")
        .map(message => ({ role: message.role, content: message.content } as FollowUpMessage)));
      const latestFollowUp = messages.filter(message => message.role === "assistant" && message.kind === "follow_up").slice(-1)[0];
      if (latestFollowUp) {
        const usage = latestFollowUp.metadata?.usage as { totalTokens?: unknown } | undefined;
        setFollowUpUsage({ model: typeof latestFollowUp.metadata?.model === "string" ? latestFollowUp.metadata.model : "AI model", totalTokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : null });
      }

      const failedUserMessage = messages.slice().reverse().find(message => message.role === "user" && (message.status === "failed" || message.status === "save_failed"));
      if (failedUserMessage) {
        setFailedRequest({
          partnerId,
          kind: failedUserMessage.kind === "follow_up" ? "follow_up" : "structured_response",
          conversationId,
          userMessageId: failedUserMessage.id,
          question: failedUserMessage.content,
        });
        if (failedUserMessage.status === "save_failed") {
          setConversationSaveStatus("failed");
          setConversationSaveError("The previous AI reply could not be restored from storage. Your question is saved; retry to generate and save a fresh reply.");
        }
        if (failedUserMessage.kind === "follow_up") {
          setFollowUpError(failedUserMessage.status === "save_failed" ? "The previous reply could not be saved. Your question is saved and can be retried." : "The previous AI response failed. Your question is saved and can be retried.");
        } else {
          setLiveError(failedUserMessage.status === "save_failed" ? "The previous reply could not be saved. Your idea is saved and can be retried." : "The previous AI response failed. Your idea is saved and can be retried.");
        }
      }
      setConversationSaveStatus("saved");
    } catch (error) {
      setConversationIdsByPartner(current => {
        if (current[partnerId] !== conversationId) return current;
        const next = { ...current };
        delete next[partnerId];
        return next;
      });
      setConversationSaveStatus("failed");
      setConversationSaveError(error instanceof Error ? error.message : "This conversation could not be restored.");
    }
  }

  function openPartner(id: PartnerId) {
    setActivePartnerId(id);
    clearLiveResponse();
    const conversationId = conversationIdsByPartner[id];
    if (conversationId) void loadPartnerConversation(id, conversationId);
    window.requestAnimationFrame(() => document.getElementById("partner-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function retryConversationSave() {
    if (!pendingReply || !failedRequest) return;
    setConversationSaveStatus("saving");
    setConversationStorageNeedsSetup(false);
    setConversationSaveError("");
    try {
      const response = await fetch("/api/ai/conversations/" + failedRequest.conversationId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "retry_save",
          userMessageId: failedRequest.userMessageId,
          reply: pendingReply,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;
        throw new Error(message || "The conversation could not be saved.");
      }
      setConversationSaveStatus("saved");
      setConversationSaveError("");
      setPendingReply(null);
      setFailedRequest(null);
    } catch (error) {
      setConversationSaveStatus("failed");
      setConversationSaveError(error instanceof Error ? error.message : "The conversation could not be saved.");
    }
  }

  function retryFailedAIRequest() {
    if (pendingReply) {
      void retryConversationSave();
      return;
    }
    if (failedRequest) {
      if (failedRequest.kind === "structured_response") {
        void generatePartnerResponse(failedRequest.partnerId, failedRequest.userMessageId);
      } else {
        void submitFollowUp(undefined, failedRequest.userMessageId, failedRequest.question);
      }
      return;
    }
    if (followUpError && followUp.trim()) {
      void submitFollowUp(undefined, undefined, followUp.trim());
    } else if (activePartner) {
      void generatePartnerResponse(activePartner.id);
    }
  }

  function prepareNextStep(partner: Partner, suggestedStep?: string) {
    setDraft(suggestedStep || partner.nextStep(ideaForDemo));
    setDraftPartnerId(partner.id);
    setDraftReady(true);
    setDraftError("");
    window.requestAnimationFrame(() => document.getElementById("shared-draft")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  function continueWithDraft() {
    const nextStep = draft.trim();
    if (!nextStep) return;
    try {
      window.localStorage.setItem("aiask-next-step-draft", nextStep);
      window.location.assign("/?view=todos&continue=1");
    } catch {
      setDraftError("This step couldn’t be passed to To-do. Check this browser’s storage and try again.");
    }
  }

  async function submitFollowUp(event?: FormEvent<HTMLFormElement>, retryMessageId?: string, retryQuestion?: string) {
    event?.preventDefault();
    const question = (retryQuestion ?? followUp).trim();
    if (!question || !activePartner || !hasIdea || followUpLoading) return;
    if (question.length > 1000) {
      setFollowUpError("Keep follow-up questions under 1,000 characters.");
      return;
    }

    const perspectiveContext = JSON.stringify(liveResponse
      ? liveResponse
      : {
          perspective: activePartner.perspective(ideaForDemo),
          questions: activePartner.questions(ideaForDemo),
          watchFor: activePartner.watchFor(ideaForDemo),
          nextStep: activePartner.nextStep(ideaForDemo),
        });
    const previousMessages = followUpMessages;
    const nextHistory: FollowUpMessage[] = retryMessageId
      ? previousMessages
      : [...previousMessages.slice(-6), { role: "user", content: question }];
    const controller = new AbortController();
    followUpRequest.current?.abort();
    followUpRequest.current = controller;
    let userQuestionSaved = false;
    setFollowUpLoading(true);
    setFollowUpError("");
    setFollowUpNeedsSignIn(false);
    setConversationSaveStatus("saving");
    setConversationSaveError("");
    setPendingReply(null);
    setFailedRequest(null);
    setFollowUpMessages(nextHistory);
    setFollowUp("");

    try {
      const conversationId = conversationIdsByPartner[activePartner.id];
      const response = await fetch("/api/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "follow_up",
          partnerRole: activePartner.id,
          userMessage: question,
          originalIdea: ideaText.trim(),
          perspectiveContext,
          // Full conversation context is loaded from saved messages by the server.
          history: nextHistory.map(message => ({ ...message, content: message.content.slice(0, 1200) })),
          ...(conversationId ? { conversationId } : {}),
          ...(retryMessageId ? { retryMessageId } : {}),
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (response.ok && payload && typeof payload === "object") {
        const savedPayload = payload as { conversationId?: unknown; userMessageId?: unknown };
        userQuestionSaved = typeof savedPayload.conversationId === "string" && typeof savedPayload.userMessageId === "string";
      }
      if (!response.ok) {
        const responsePayload = payload && typeof payload === "object" ? payload as {
          error?: { code?: string; message?: string };
          conversationId?: string;
          userMessageId?: string;
          historySaved?: boolean;
        } : {};
        const error = responsePayload.error;
        setFollowUpNeedsSignIn(error?.code === "sign_in_required");
        setConversationStorageNeedsSetup(error?.code === "conversation_storage_unavailable");
        if (responsePayload.conversationId) {
          setConversationIdsByPartner(current => ({ ...current, [activePartner.id]: responsePayload.conversationId }));
        }
        userQuestionSaved = responsePayload.historySaved === true;
        setConversationSaveStatus(userQuestionSaved ? "saved" : "idle");
        if (userQuestionSaved && responsePayload.conversationId && responsePayload.userMessageId) {
          setFailedRequest({ partnerId: activePartner.id, kind: "follow_up", conversationId: responsePayload.conversationId, userMessageId: responsePayload.userMessageId, question });
        }
        throw new Error(error?.message || "The AI Team role could not complete this follow-up.");
      }
      const result = validateAIASKOutput(payload);
      if (!result || result.partnerRole !== activePartner.id || typeof result.answer !== "string") {
        throw new Error("The AI service returned an unexpected follow-up response.");
      }

      if (result.conversationId) setConversationIdsByPartner(current => ({ ...current, [activePartner.id]: result.conversationId }));
      const completedHistory: FollowUpMessage[] = [...nextHistory, { role: "assistant" as const, content: result.answer }].slice(-8);
      setFollowUpMessages(completedHistory);
      setFollowUpUsage({
        model: result.model || "AI model",
        totalTokens: typeof result.usage?.totalTokens === "number" ? result.usage.totalTokens : null,
      });
      if (result.saved === false) {
        setConversationSaveStatus("failed");
        setConversationSaveError("The AI answered, but the reply could not be saved.");
        setPendingReply({ kind: "follow_up", answer: result.answer, model: result.model || "AI model", usage: result.usage });
        if (result.conversationId && result.userMessageId) {
          setFailedRequest({ partnerId: activePartner.id, kind: "follow_up", conversationId: result.conversationId, userMessageId: result.userMessageId, question });
        }
      } else {
        setConversationSaveStatus("saved");
        setConversationSaveError("");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setFollowUpMessages(userQuestionSaved ? nextHistory : previousMessages);
      setFollowUp(question);
      setConversationSaveStatus(current => current === "saving" ? "idle" : current);
      setFollowUpError(error instanceof Error ? error.message : "The AI Team role could not complete this follow-up.");
    } finally {
      if (followUpRequest.current === controller) {
        followUpRequest.current = null;
        setFollowUpLoading(false);
      }
    }
  }

  return <main className="partners-page">
    <SiteNavigation active="partners" />

    <section className="partners-hero partners-wrap">
      <Link href="/" className="partners-back"><ArrowLeft size={13} /> AIASK home</Link>
      <div className="partners-hero-grid"><div><p className="partners-eyebrow"><span /> ONE COORDINATED AI EXPERIENCE</p><h1>One idea.<br /><em>Different perspectives.</em><br />Better decisions.</h1><p className="partners-lead">Meet the six AI Team roles that help you clarify, plan, discover, evaluate, decide, and follow through.</p><div className="partners-proof"><span><Sparkles size={14} /></span><p>Six complementary roles. One shared experience. You stay in control of the direction.</p></div></div><aside className="partners-idea-card"><div className="idea-card-top"><span><Lightbulb size={14} /> START WITH A THOUGHT</span><span className="demo-tag">DEMO</span></div><label htmlFor="partner-idea">What would you like to explore?</label>{storageReady && savedIdeas.length > 0 && <div className="saved-idea-select"><span>From your Idea Box</span><div className="select-wrap"><select aria-label="Choose a saved Idea Box thought" value={selectedIdeaId || "custom"} onChange={event => selectSavedIdea(event.target.value)}><option value="custom">Write a different idea</option>{savedIdeas.map(idea => <option value={idea.id} key={idea.id}>{idea.text.replace(/\s+/g, " ").slice(0, 82)}</option>)}</select><ChevronDown size={14} /></div></div>}<textarea id="partner-idea" value={ideaText} onChange={event => changeIdea(event.target.value)} rows={4} placeholder="A goal, a question, something you’re considering…"/><div className="idea-card-footer"><span>{selectedIdeaId ? "Using a saved thought" : "Your words stay here until you request live AI"}</span><a href="#partner-cards">Explore perspectives <ArrowDown size={13} /></a></div></aside></div>
    </section>

    <section className="partner-cards-section" id="partner-cards"><div className="partners-wrap"><div className="partners-section-head"><div><p className="partners-eyebrow">SIX WAYS TO LOOK AT IT</p><h2>Meet your AI team.</h2></div><p>Each role brings a different lens to the same thought. Choose one to see how it would approach your idea.</p></div><p className="demo-disclosure"><span><Sparkles size={13} /></span> All six AI Team roles can generate structured live responses and role-aware follow-ups using the configured model.</p><div className="partner-card-grid">{partners.map((partner, index) => { const Icon = partner.icon; return <article className={`partner-card ${partner.color}`} key={partner.id}><div className="partner-card-top"><span className="partner-number">0{index + 1}</span><span className={"partner-mode live"}>LIVE AI PILOT</span><span className="partner-icon"><Icon size={19} /></span></div><p className="partner-card-name">{partner.name}<span>{partner.chinese}</span></p><h3>{partner.lens}</h3><p className="partner-card-description">{partner.description}</p><blockquote>{partner.perspective(ideaForDemo)}</blockquote><button type="button" aria-controls="partner-detail" aria-expanded={activePartnerId === partner.id} onClick={() => openPartner(partner.id)}>Explore perspective <ArrowUpRight size={14} /></button></article>; })}</div></div></section>

    {activePartner && <section className="partner-detail-section" id="partner-detail" aria-labelledby="partner-detail-title"><div className="partners-wrap"><div className="detail-title-row"><div><p className="partners-eyebrow">A CLOSER LOOK</p><h2>Inside this perspective.</h2></div><button className="detail-close" type="button" onClick={() => { clearLiveResponse(); setActivePartnerId(null); }}><X size={15} /> Close</button></div><div className={`partner-detail-card ${activePartner.color}`}><div className="detail-identity"><span className="partner-icon"><activePartner.icon size={21} /></span><div><p>{activePartner.name}<span>{activePartner.chinese}</span></p><h3 id="partner-detail-title">{activePartner.lens}</h3></div><span className="detail-tone">{activePartner.tone}</span></div><p className="detail-description">{activePartner.thinkingStyle}</p><div className="guide-live-panel"><div><span className="detail-label">LIVE AI PILOT · {activePartner.name.toUpperCase()}</span><p>When you request a response, this idea text is sent to the configured model provider through the AIASK server. No tasks, calendar items, or other workspace context are included.</p></div><button type="button" onClick={() => void generatePartnerResponse(activePartner.id)} disabled={!hasIdea || liveLoading}>{liveLoading ? "Thinking…" : liveResponse ? "Generate another response" : "Generate a live response"}<Sparkles size={14} /></button>{liveNeedsSignIn && <p className="guide-live-error" role="alert">{liveError} <Link href="/login?next=%2Fpartners">Sign in</Link></p>}{liveError && !liveNeedsSignIn && <p className="guide-live-error" role="alert">{liveError}{!conversationStorageNeedsSetup && <button type="button" onClick={retryFailedAIRequest}>Retry</button>}</p>}{liveLoading && <p className="guide-live-status" role="status">{activePartner.name} is preparing a structured perspective…</p>}{!hasIdea && <p className="guide-live-status">Add an idea above to enable the live request.</p>}{conversationSaveStatus !== "idle" && <p className={conversationSaveStatus === "failed" ? "conversation-save-state failed" : "conversation-save-state"} role="status">{conversationSaveStatus === "saving" ? "Saving…" : conversationSaveStatus === "saved" ? "Saved" : "Save failed"}{conversationSaveStatus === "failed" && <><span>{conversationSaveError || "Your conversation needs another save attempt."}</span><button type="button" onClick={retryFailedAIRequest}>Retry</button></>}</p>}</div><div className="detail-content-grid"><article className="detail-perspective"><span className="detail-label">{liveResponse ? (activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "KNOWLEDGE BRIEFING" : "LIVE AI PERSPECTIVE") : "A PERSPECTIVE ON YOUR IDEA"}</span><div className="perspective-reading"><MarkdownContent content={liveResponse ? liveResponse.perspective : activePartner.perspective(ideaForDemo)} readableParagraphs /></div><div className="detail-idea-context"><Lightbulb size={13} /><span>{hasIdea ? ideaText : "Add your own thought above to make this perspective personal."}</span></div></article><article className="detail-questions"><span className="detail-label">{activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "QUESTIONS TO EXPLORE" : "QUESTIONS THIS ROLE WOULD ASK"}</span><ol>{(liveResponse ? liveResponse.questions : activePartner.questions(ideaForDemo)).map((question, index) => <li key={`${activePartner.id}-${index}`}>{question}</li>)}</ol></article><article className="detail-watch"><span className="detail-label">{liveResponse ? (activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "ASSUMPTIONS, CONNECTIONS & EVIDENCE GAPS" : "RISKS, OPPORTUNITIES & GAPS") : "WHAT TO KEEP IN VIEW"}</span>{liveResponse ? <ul className="guide-insight-list">{liveResponse.risks.map((item, index) => <li key={`risk-${index}`}><b>{activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "Critical check" : "Risk"}</b>{item}</li>)}{liveResponse.opportunities.map((item, index) => <li key={`opportunity-${index}`}><b>{activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "Connection" : "Opportunity"}</b>{item}</li>)}{liveResponse.uncertainty.map((item, index) => <li key={`gap-${index}`}><b>{activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "Evidence gap" : "Uncertainty"}</b>{item}</li>)}</ul> : <p>{activePartner.watchFor(ideaForDemo)}</p>}</article><article className="detail-next"><span className="detail-label">A POSSIBLE NEXT STEP</span><p>{liveResponse ? liveResponse.nextStep : activePartner.nextStep(ideaForDemo)}</p><button type="button" onClick={() => prepareNextStep(activePartner, liveResponse?.nextStep)}>Prepare as a potential next step <ArrowRight size={13} /></button></article></div><div className="partner-discussion"><div className="partner-discussion-copy"><span className="detail-label">LIVE FOLLOW-UP</span><h3>Continue the conversation.</h3><p>Ask about this perspective. Your idea and conversation go to the configured model using the selected AI Team role.</p></div><FollowUpComposer id="partner-follow-up" value={followUp} onChange={setFollowUp} onSubmit={submitFollowUp} disabled={!hasIdea} loading={followUpLoading} />{followUpMessages.length > 0 && <div className="follow-up-thread" aria-live="polite">{followUpMessages.map((message, index) => <article className={message.role === "user" ? "follow-up-message user" : "follow-up-message assistant"} key={`${index}-${message.role}`}><b>{message.role === "user" ? "You" : activePartner.name}</b>{message.role === "assistant" ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}</article>)}</div>}{followUpLoading && <p className="follow-up-status" role="status">{activePartner.name} is thinking…</p>}{followUpError && <p className="follow-up-error" role="alert">{followUpError}{followUpNeedsSignIn && <> <Link href="/login?next=%2Fpartners">Sign in</Link></>}{!conversationStorageNeedsSetup && !followUpNeedsSignIn && <button type="button" onClick={retryFailedAIRequest}>Retry</button>}</p>}{followUpMessages.length > 0 && <div className="follow-up-bottom"><p>Continue the conversation</p><FollowUpComposer id="partner-follow-up-bottom" value={followUp} onChange={setFollowUp} onSubmit={submitFollowUp} disabled={!hasIdea} loading={followUpLoading} label="Follow-up at the end of the conversation" /></div>}</div><div className="detail-demo-foot"><Sparkles size={13} />{liveResponse ? <>{activePartner.id === PARTNER_ROLE_ID.knowledgePartner ? "Knowledge briefing · No live research source is connected; verify current claims against reliable sources." : "AI-generated suggestion · Not verified research and not an approved task."}{displayedUsage && <span className="guide-usage">{displayedUsage.model}{displayedUsage.totalTokens !== null ? ` · ${displayedUsage.totalTokens} tokens` : ""}</span>}</> : <>Generate a live response or follow-up with this AI Team role. No research source is connected.{displayedUsage && <span className="guide-usage">{displayedUsage.model}{displayedUsage.totalTokens !== null ? ` · ${displayedUsage.totalTokens} tokens` : ""}</span>}</>}</div></div></div></section>}

    <section className="shared-section"><div className="partners-wrap">
      <div className="partners-section-head shared-heading"><div><p className="partners-eyebrow">INSIGHT TO ACTION</p><h2>Carry it forward.</h2></div><p>Choose “Prepare as a potential next step” from an AI Team perspective above. Refine the draft here, then continue to To-do.</p></div>
      <div className={draftReady ? "shared-draft ready" : "shared-draft"} id="shared-draft"><div className="shared-draft-head"><div><span className="detail-label">POTENTIAL NEXT STEP</span><h3>{draftReady ? `A draft from ${getPartner(draftPartnerId)?.name ?? "your selected perspective"}` : "Choose an insight to prepare"}</h3></div>{draftReady && <button type="button" className="draft-clear" onClick={() => { setDraft(""); setDraftPartnerId(null); setDraftReady(false); setDraftError(""); }}>Clear draft</button>}</div><label className="sr-only" htmlFor="shared-draft-input">Potential next step draft</label><textarea id="shared-draft-input" value={draft} onChange={event => { setDraft(event.target.value); setDraftReady(true); setDraftError(""); }} placeholder="Choose an AI Team perspective above to prepare a next step for review." rows={3}/><div className="shared-draft-footer"><p><Check size={13} /> Draft only until you continue. This opens To-do with the step prefilled; you confirm before saving it.</p><button type="button" className="shared-draft-continue" onClick={continueWithDraft} disabled={!draft.trim()}>Continue to execution <ArrowRight size={13}/></button></div>{draftError && <p className="shared-draft-error" role="alert">{draftError}</p>}</div>
    </div></section>

    <footer className="partners-footer"><div className="partners-wrap"><span>aiask<span>.</span></span><p>One team. A whole lot of range.</p><Link href="/workspace">Open My Workspace <ArrowUpRight size={13} /></Link></div></footer>
  </main>;
}
