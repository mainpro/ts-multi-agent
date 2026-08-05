import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { SkillMetadata } from '../types';
import {
  SubRequirement,
  SkillMatchResult,
  SkillMatchType,
} from '../types/requirement-types';
import { buildSubRequirementMatcherPrompt } from '../prompts/skill-matcher';
import { sessionContextService } from '../memory';
import * as fs from 'fs';
import * as path from 'path';

const KEYWORD_CACHE_FILE = 'data/keyword-cache.json';

export interface MatchContext {
  recentSkill?: string;
  conversationContext?: string;
  sessionId?: string;
}

const SkillMatchResponseSchema = z.object({
  skill: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1),
  matchType: z.enum(['direct', 'inferred', 'none']),
  reasoning: z.string().optional(),
});

export class SkillMatcher {
  private skillKeywordMap: Map<string, string[]> = new Map();

  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry
  ) {
    this.buildKeywordMap();
  }

  private buildKeywordMap(): void {
    const skills = this.skillRegistry.getAllMetadata();
    const keywordMap = new Map<string, string[]>();

    const cacheKey = JSON.stringify(skills.map(s => ({ name: s.name, description: s.description })));
    const cachedKeywords = this.loadKeywordCache(cacheKey);

    if (cachedKeywords) {
      for (const [kw, skillNames] of Object.entries(cachedKeywords)) {
        keywordMap.set(kw, skillNames);
      }
      console.log(`[SkillMatcher] 📚 关键词映射已加载缓存: ${keywordMap.size} 个关键词`);
    } else {
      for (const skill of skills) {
        const keywords = this.extractKeywordsFromDescription(skill.description);

        for (const kw of keywords) {
          if (!keywordMap.has(kw)) {
            keywordMap.set(kw, []);
          }
          keywordMap.get(kw)!.push(skill.name);
        }
      }
      this.saveKeywordCache(cacheKey, Object.fromEntries(keywordMap));
      console.log(`[SkillMatcher] 📚 关键词映射已构建: ${keywordMap.size} 个关键词`);
    }

    console.log(`[SkillMatcher] 🎯 技能: ${skills.map(s => s.name).join(', ')}`);
    this.skillKeywordMap = keywordMap;
  }

  private loadKeywordCache(skillKey: string): Record<string, string[]> | null {
    try {
      if (!fs.existsSync(KEYWORD_CACHE_FILE)) return null;
      const cache = JSON.parse(fs.readFileSync(KEYWORD_CACHE_FILE, 'utf-8'));
      if (cache.key !== skillKey) return null;
      return cache.keywords;
    } catch {
      return null;
    }
  }

  private saveKeywordCache(skillKey: string, keywords: Record<string, string[]>): void {
    try {
      const dir = path.dirname(KEYWORD_CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(KEYWORD_CACHE_FILE, JSON.stringify({ key: skillKey, keywords }, null, 2));
    } catch (e) {
      console.warn('[SkillMatcher] 关键词缓存保存失败:', e);
    }
  }

  private extractKeywordsFromDescription(description: string): string[] {
    const keywords: string[] = [];
    const fullText = `${description}`.toLowerCase();

    const stopWords = new Set([
      '的', '了', '是', '在', '和', '与', '或', '及', '等', '及', '可以', '能够', '需要', '可能', '如果', '那么',
      '用户', '系统', '问题', '情况', '相关', '功能', '操作', '使用', '帮助', '查询', '申请', '处理', '解决',
      'the', 'and', 'or', 'is', 'are', 'be', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from',
      '海尔', '集团', '助手', '触发', '场景', '排除', '包含', '涉及', '提到', '询问', '发送', '截图', '地址栏',
    ]);

    const chinesePattern = /[\u4e00-\u9fff]{2,6}/g;
    const chineseMatches = fullText.match(chinesePattern) || [];
    for (const word of chineseMatches) {
      if (!stopWords.has(word) && word.length >= 2 && !keywords.includes(word)) {
        keywords.push(word);
      }
    }

    const englishPattern = /[a-zA-Z]{2,}/g;
    const englishMatches = fullText.match(englishPattern) || [];
    for (const word of englishMatches) {
      const upper = word.toUpperCase();
      if (!stopWords.has(upper) && upper.length >= 2 && !keywords.includes(upper)) {
        keywords.push(upper);
      }
    }

    return keywords;
  }

  private keywordMatchSkill(content: string): { matchedSkill?: string; matchedSkills?: string[]; confidence: number; isAmbiguous?: boolean } {
    const lowerInput = content.toLowerCase();
    const matchedSkills = new Set<string>();

    for (const [keyword, skills] of this.skillKeywordMap) {
      if (lowerInput.includes(keyword)) {
        for (const skill of skills) {
          matchedSkills.add(skill);
        }
      }
    }

    if (matchedSkills.size === 1) {
      const skill = Array.from(matchedSkills)[0];
      console.log(`[SkillMatcher] ⚡ 关键词命中技能: ${skill} (唯一匹配)`);
      return { matchedSkill: skill, matchedSkills: [skill], confidence: 0.9 };
    } else if (matchedSkills.size > 1) {
      const skillList = Array.from(matchedSkills);
      console.log(`[SkillMatcher] ⚠️ 关键词命中多个技能: ${skillList.join(',')} (需要LLM决策)`);
      return { matchedSkill: skillList[0], matchedSkills: skillList, confidence: 0.7, isAmbiguous: true };
    }

    return { matchedSkill: undefined, matchedSkills: [], confidence: 0 };
  }

  async matchSkill(
    subReq: SubRequirement,
    context?: MatchContext
  ): Promise<SkillMatchResult> {
    const keywordResult = this.keywordMatchSkill(subReq.normalizedContent || subReq.content);

    if (keywordResult.matchedSkill && keywordResult.confidence >= 0.9 && !keywordResult.isAmbiguous) {
      return {
        subReqId: subReq.id,
        skill: keywordResult.matchedSkill,
        confidence: keywordResult.confidence,
        matchType: 'direct' as SkillMatchType,
        reasoning: '关键词直接匹配',
      };
    }

    console.log(`[SkillMatcher] 🤖 使用 LLM 匹配子需求: ${subReq.id}`);

    try {
      const skills = this.skillRegistry.getAllMetadata();

      let sessionPriorityContext: string | undefined;
      if (context?.sessionId) {
        sessionPriorityContext = sessionContextService.buildPriorityPrompt(context.sessionId);
      }

      const { systemPrompt, userPrompt } = buildSubRequirementMatcherPrompt(skills, subReq, {
        ...context,
        sessionPriorityContext,
      });

      const result = await this.llm.generateStructured(
        userPrompt,
        SkillMatchResponseSchema,
        systemPrompt
      );

      const matchType = result.matchType as SkillMatchType;

      if (matchType === 'none' || !result.skill) {
        return {
          subReqId: subReq.id,
          skill: undefined,
          confidence: result.confidence,
          matchType: 'none',
          reasoning: result.reasoning || 'LLM 无法匹配',
        };
      }

      return {
        subReqId: subReq.id,
        skill: result.skill,
        confidence: result.confidence,
        matchType,
        reasoning: result.reasoning,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`[SkillMatcher] ⚠️ LLM 匹配失败: ${errorMsg}`);

      if (keywordResult.matchedSkill) {
        return {
          subReqId: subReq.id,
          skill: keywordResult.matchedSkill,
          confidence: keywordResult.confidence,
          matchType: 'inferred' as SkillMatchType,
          reasoning: 'LLM 失败，使用关键词匹配结果',
        };
      }

      return {
        subReqId: subReq.id,
        skill: undefined,
        confidence: 0,
        matchType: 'none',
        reasoning: `匹配失败: ${errorMsg}`,
      };
    }
  }

  async matchSkills(
    subReqs: SubRequirement[],
    context?: MatchContext
  ): Promise<SkillMatchResult[]> {
    console.log(`[SkillMatcher] 🚀 批量匹配 ${subReqs.length} 个子需求`);

    const results = await Promise.all(
      subReqs.map(subReq => this.matchSkill(subReq, context))
    );

    console.log(`[SkillMatcher] ✅ 批量匹配完成`);
    return results;
  }

  getSkillKeywordMap(): Map<string, string[]> {
    return new Map(this.skillKeywordMap);
  }

  getSkills(): SkillMetadata[] {
    return this.skillRegistry.getAllMetadata();
  }
}

export default SkillMatcher;
