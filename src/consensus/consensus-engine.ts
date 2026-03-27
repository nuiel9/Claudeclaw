import type {
  ConsensusRequest,
  ConsensusVote,
  ConsensusResult,
  ConsensusMode,
  Logger,
} from "../core/types.js";
import { ClaudeclawEventBus } from "../core/events.js";

/**
 * Function type for getting an agent's vote/opinion
 */
export type VoteCollector = (
  agentId: string,
  question: string,
  context: string,
  round: number,
  previousVotes?: ConsensusVote[]
) => Promise<ConsensusVote>;

/**
 * Agent Consensus Engine
 * Supports: majority-vote, debate, ranked-choice, unanimous
 */
export class ConsensusEngine {
  private eventBus: ClaudeclawEventBus;
  private logger: Logger;

  constructor(eventBus: ClaudeclawEventBus, logger: Logger) {
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Run a consensus process
   */
  async resolve(
    request: ConsensusRequest,
    collector: VoteCollector
  ): Promise<ConsensusResult> {
    this.eventBus.emit("consensus:started", {
      type: "consensus:started",
      request,
    });

    this.logger.info(
      `Consensus started: ${request.mode} with ${request.agents.length} agents`
    );

    let result: ConsensusResult;

    switch (request.mode) {
      case "majority-vote":
        result = await this.majorityVote(request, collector);
        break;
      case "debate":
        result = await this.debate(request, collector);
        break;
      case "ranked-choice":
        result = await this.rankedChoice(request, collector);
        break;
      case "unanimous":
        result = await this.unanimous(request, collector);
        break;
      default:
        throw new Error(`Unknown consensus mode: ${request.mode}`);
    }

    this.eventBus.emit("consensus:completed", {
      type: "consensus:completed",
      result,
    });

    this.logger.info(
      `Consensus completed: "${result.decision}" (confidence: ${result.confidence})`
    );

    return result;
  }

  // --- Majority Vote ---

  private async majorityVote(
    request: ConsensusRequest,
    collector: VoteCollector
  ): Promise<ConsensusResult> {
    // Collect votes from all agents in parallel
    const votes = await Promise.all(
      request.agents.map((agentId) =>
        collector(
          agentId,
          request.question,
          request.context ?? "",
          1
        )
      )
    );

    // Tally votes
    const tally = new Map<string, number>();
    for (const vote of votes) {
      const key = vote.answer.toLowerCase().trim();
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }

    // Find majority
    let maxCount = 0;
    let decision = "";
    for (const [answer, count] of tally) {
      if (count > maxCount) {
        maxCount = count;
        decision = answer;
      }
    }

    const totalVotes = votes.length;
    const unanimous = maxCount === totalVotes;

    return {
      decision,
      votes,
      rounds: 1,
      unanimous,
      confidence: maxCount / totalVotes,
    };
  }

  // --- Debate ---

  private async debate(
    request: ConsensusRequest,
    collector: VoteCollector
  ): Promise<ConsensusResult> {
    const maxRounds = request.maxRounds ?? 3;
    let allVotes: ConsensusVote[] = [];
    let round = 0;

    for (round = 1; round <= maxRounds; round++) {
      this.logger.info(`Debate round ${round}/${maxRounds}`);

      // Each agent sees previous round's votes
      const roundVotes = await Promise.all(
        request.agents.map((agentId) =>
          collector(
            agentId,
            request.question,
            request.context ?? "",
            round,
            allVotes
          )
        )
      );

      allVotes = roundVotes;

      // Check for convergence
      const answers = new Set(
        roundVotes.map((v) => v.answer.toLowerCase().trim())
      );
      if (answers.size === 1) {
        this.logger.info(`Debate converged at round ${round}`);
        break;
      }

      // Check if confidence is high enough
      const avgConfidence =
        roundVotes.reduce((sum, v) => sum + v.confidence, 0) /
        roundVotes.length;
      if (avgConfidence > 0.9) {
        this.logger.info(
          `Debate: high confidence convergence at round ${round}`
        );
        break;
      }
    }

    // Take the highest-confidence answer
    const sorted = [...allVotes].sort(
      (a, b) => b.confidence - a.confidence
    );
    const decision = sorted[0].answer;
    const unanimous = allVotes.every(
      (v) => v.answer.toLowerCase().trim() === decision.toLowerCase().trim()
    );

    return {
      decision,
      votes: allVotes,
      rounds: round,
      unanimous,
      confidence:
        allVotes.reduce((sum, v) => sum + v.confidence, 0) /
        allVotes.length,
    };
  }

  // --- Ranked Choice ---

  private async rankedChoice(
    request: ConsensusRequest,
    collector: VoteCollector
  ): Promise<ConsensusResult> {
    // Collect votes with rankings (confidence = rank weight)
    const votes = await Promise.all(
      request.agents.map((agentId) =>
        collector(
          agentId,
          request.question,
          request.context ?? "",
          1
        )
      )
    );

    // Score answers by weighted confidence
    const scores = new Map<string, number>();
    for (const vote of votes) {
      const key = vote.answer.toLowerCase().trim();
      scores.set(key, (scores.get(key) ?? 0) + vote.confidence);
    }

    // Find highest-scored answer
    let maxScore = 0;
    let decision = "";
    for (const [answer, score] of scores) {
      if (score > maxScore) {
        maxScore = score;
        decision = answer;
      }
    }

    const totalPossible = votes.length; // max 1.0 per agent
    const unanimous = votes.every(
      (v) => v.answer.toLowerCase().trim() === decision
    );

    return {
      decision,
      votes,
      rounds: 1,
      unanimous,
      confidence: maxScore / totalPossible,
    };
  }

  // --- Unanimous ---

  private async unanimous(
    request: ConsensusRequest,
    collector: VoteCollector
  ): Promise<ConsensusResult> {
    const maxRounds = request.maxRounds ?? 5;
    let allVotes: ConsensusVote[] = [];

    for (let round = 1; round <= maxRounds; round++) {
      this.logger.info(`Unanimous round ${round}/${maxRounds}`);

      const roundVotes = await Promise.all(
        request.agents.map((agentId) =>
          collector(
            agentId,
            request.question,
            request.context ?? "",
            round,
            allVotes
          )
        )
      );

      allVotes = roundVotes;

      const answers = new Set(
        roundVotes.map((v) => v.answer.toLowerCase().trim())
      );
      if (answers.size === 1) {
        return {
          decision: roundVotes[0].answer,
          votes: roundVotes,
          rounds: round,
          unanimous: true,
          confidence:
            roundVotes.reduce((sum, v) => sum + v.confidence, 0) /
            roundVotes.length,
        };
      }
    }

    // Failed to reach unanimity - fall back to majority
    this.logger.warn("Failed to reach unanimity, falling back to majority");
    return this.majorityVote(request, collector);
  }
}
