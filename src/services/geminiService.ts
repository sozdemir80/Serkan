import { GoogleGenAI, Type } from "@google/genai";
import { db, auth, handleFirestoreError, OperationType } from "../firebase";
import { collection, query, where, getDocs, addDoc, updateDoc, doc, increment, limit, Timestamp } from "firebase/firestore";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface Question {
  id: string;
  topic: string;
  question: string;
  codeSnippet?: string;
  options: string[];
  correctAnswerIndex: number;
  explanation: string;
}

export async function getQuestionFromPool(topics: string[], difficulty: string, userId: string): Promise<Question | null> {
  const topic = topics[Math.floor(Math.random() * topics.length)];
  try {
    // 1. Get user history for this topic and difficulty
    const historyQuery = query(
      collection(db, 'userQuestionHistory'),
      where('userId', '==', userId),
      where('topic', '==', topic),
      where('difficulty', '==', difficulty)
    );
    
    const historySnapshot = await getDocs(historyQuery);
    const history = historySnapshot.docs.map(doc => doc.data());
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = Timestamp.fromDate(today);

    const correctlyAnsweredIds = history.filter(h => h.isCorrect).map(h => h.questionId);
    const seenTodayIds = history
      .filter(h => h.lastAsked.toMillis() >= todayTimestamp.toMillis())
      .map(h => h.questionId);

    // 2. Fetch potential questions from the pool
    const qPool = query(
      collection(db, 'questions'),
      where('topic', '==', topic),
      where('difficulty', '==', difficulty),
      limit(50) 
    );
    
    const poolSnapshot = await getDocs(qPool);
    const allPoolQuestions = poolSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as any));

    // 3. Apply filtering rules
    let availableQuestions = allPoolQuestions.filter(q => !seenTodayIds.includes(q.id));
    const uncorrectlyAnswered = availableQuestions.filter(q => !correctlyAnsweredIds.includes(q.id));
    
    if (uncorrectlyAnswered.length > 0) {
      availableQuestions = uncorrectlyAnswered;
    }

    if (availableQuestions.length > 0) {
      const randomQuestion = availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
      
      updateDoc(doc(db, 'questions', randomQuestion.id), {
        usageCount: increment(1)
      }).catch(e => console.error("Usage count update failed", e));

      return {
        id: randomQuestion.id,
        topic,
        question: randomQuestion.question,
        codeSnippet: randomQuestion.codeSnippet,
        options: randomQuestion.options,
        correctAnswerIndex: randomQuestion.correctAnswerIndex,
        explanation: randomQuestion.explanation
      };
    }
  } catch (error) {
    console.error("Pool fetch failed", error);
  }
  return null;
}

export async function generateQuestion(topics: string[], difficulty: string, userId?: string, forceGenerate: boolean = false): Promise<Question> {
  const topic = topics[Math.floor(Math.random() * topics.length)];
  
  if (!forceGenerate && userId) {
    const poolQuestion = await getQuestionFromPool([topic], difficulty, userId);
    if (poolQuestion) return poolQuestion;
  }

  // Fallback to AI Generation
  const difficultyGuidelines = {
    "Easy": `Focus on absolute beginner concepts. 
      - Basic syntax, variables (int, float, string, bool), basic arithmetic (+, -, *, /, //, %, **).
      - Simple print() and input() with type casting.
      - Basic string operations (concatenation, repetition, len()).
      - Simple if-else statements (no nesting).
      - Basic error types (NameError, TypeError).
      STRICTLY FORBIDDEN: lambda, list comprehensions, decorators, classes, complex loops, or semicolons (;).`,
    "Medium": `Focus on intermediate logic and data structures.
      - For and While loops, nested loops.
      - Lists, Tuples, Dictionaries (methods like .append, .pop, .get, .keys).
      - Basic functions (def, return, arguments).
      - List comprehensions (simple).
      - Exception handling (try/except).
      - String methods (.split, .join, .strip).
      - Modules (import math, random).`,
    "Hard": `Focus on advanced Pythonic patterns and software engineering.
      - Object-Oriented Programming (classes, inheritance, dunder methods, @property).
      - Advanced Functional Programming (lambda, map, filter, reduce).
      - Decorators and Generators (yield).
      - Complex algorithms (recursion, sorting logic).
      - Advanced modules (itertools, collections, sys).
      - Deep scoping and memory management concepts.`
  };

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Generate a unique and high-quality multiple-choice Python question.
      
      Topic: ${topic}
      Difficulty: ${difficulty}
      Guidelines: ${difficultyGuidelines[difficulty as keyof typeof difficultyGuidelines]}
      
      CRITICAL: The question MUST strictly match the ${difficulty} difficulty level. 
      Ensure the question is different from common textbook examples. 
      Include a relevant code snippet that the user needs to analyze.
      
      FORMATTING RULES (STRICT):
      1. DO NOT write multiple statements on the same line.
      2. DO NOT use semicolons (;) to separate statements.
      3. Use proper Python indentation and newlines.
      4. Each logical step must be on its own line.
      5. The codeSnippet should be at least 3-5 lines long to be readable, but simple if difficulty is Easy.
      
      Provide 4 distinct options.
      Provide a detailed pedagogical explanation.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            question: { type: Type.STRING },
            codeSnippet: { type: Type.STRING, description: "Python code snippet related to the question" },
            options: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: "Exactly 4 options"
            },
            correctAnswerIndex: { type: Type.INTEGER, description: "0-indexed index of the correct option" },
            explanation: { type: Type.STRING }
          },
          required: ["question", "codeSnippet", "options", "correctAnswerIndex", "explanation"]
        }
      }
    });

    const data = JSON.parse(response.text);
    
    // Save to pool in background
    const newQuestion = {
      topic,
      difficulty,
      ...data,
      usageCount: 1
    };
    
    addDoc(collection(db, 'questions'), newQuestion).catch(e => {
      if (e.message?.includes('permission')) {
        handleFirestoreError(e, OperationType.CREATE, 'questions');
      } else {
        console.error("Failed to save new question to pool", e);
      }
    });

    return {
      id: Math.random().toString(36).substring(7),
      topic,
      ...data
    };
  } catch (error: any) {
    const errorMsg = error.message?.toLowerCase() || "";
    const isQuotaError = errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.includes('resource_exhausted') || error.status === 'RESOURCE_EXHAUSTED';
    
    if (isQuotaError && !forceGenerate) {
      console.warn("AI Quota exceeded, attempting to fetch ANY question from pool as fallback...");
      try {
        const qPool = query(
          collection(db, 'questions'),
          where('topic', '==', topic),
          where('difficulty', '==', difficulty),
          limit(20) 
        );
        const snapshot = await getDocs(qPool);
        if (!snapshot.empty) {
          const docs = snapshot.docs;
          const randomDoc = docs[Math.floor(Math.random() * docs.length)];
          const data = randomDoc.data();
          
          updateDoc(doc(db, 'questions', randomDoc.id), {
            usageCount: increment(1)
          }).catch(e => {
            if (e.message?.includes('permission')) {
              handleFirestoreError(e, OperationType.UPDATE, 'questions');
            } else {
              console.error("Usage count update failed", e);
            }
          });

          return {
            id: randomDoc.id,
            topic,
            question: data.question,
            codeSnippet: data.codeSnippet,
            options: data.options,
            correctAnswerIndex: data.correctAnswerIndex,
            explanation: data.explanation
          };
        }
      } catch (poolError) {
        console.error("Fallback pool fetch failed", poolError);
        // We don't throw here, we want to let the original AI error propagate if pool also fails
      }
    }

    if (isQuotaError) {
      throw { status: 429, message: "Rate limit exceeded. Pool is also empty for this topic." };
    }
    throw error;
  }
}
