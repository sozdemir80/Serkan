import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Editor from '@monaco-editor/react';
import { 
  Play, 
  CheckCircle2, 
  XCircle, 
  ChevronRight, 
  RotateCcw, 
  Code2, 
  BrainCircuit, 
  Trophy,
  Loader2,
  Terminal,
  LogOut,
  LayoutDashboard,
  ArrowLeft,
  Calendar,
  User as UserIcon,
  BarChart3,
  Clock,
  History,
  ExternalLink,
  Eye,
  Trash2
} from 'lucide-react';
import { generateQuestion, getQuestionFromPool, Question } from './services/geminiService';
import { usePyodide } from './hooks/usePyodide';
import { cn } from './lib/utils';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './firebase';
import { signInWithPopup, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, addDoc, onSnapshot, query, orderBy, Timestamp, where, getDocs, limit, doc, updateDoc, deleteDoc, setDoc } from 'firebase/firestore';

const TOPICS = [
  "Variables & Data Types",
  "Control Flow (If, Loops)",
  "Functions & Modules",
  "Lists, Tuples, Dictionaries",
  "File Handling",
  "Exception Handling",
  "Object-Oriented Programming",
  "Standard Libraries",
  "Functional Programming",
  "Decorators & Generators"
];

const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const QUESTION_COUNTS = [5, 10, 20, 30];

type AppState = 'START' | 'QUIZ' | 'RESULT' | 'DASHBOARD' | 'HISTORY';

interface WrongQuestion {
  question: string;
  codeSnippet?: string;
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
  topic: string;
}

interface QuizResultData {
  id?: string;
  userId: string;
  username: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  difficulty: string;
  topics: string[];
  wrongQuestions: WrongQuestion[];
  timestamp: any;
  startTime: any;
  endTime: any;
}

interface PersistentWrongQuestion {
  id: string;
  userId: string;
  topic: string;
  questionData: Question;
  lastWrongTimestamp: any;
  isResolved?: boolean;
}

const MASTER_EMAIL = "sozdemir80@gmail.com";

export default function App() {
  const [state, setState] = useState<AppState>('START');
  const [user, setUser] = useState<User | null>(null);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState("Medium");
  const [targetQuestionCount, setTargetQuestionCount] = useState(10);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [nextQuestion, setNextQuestion] = useState<Question | null>(null);
  const [score, setScore] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [output, setOutput] = useState('');
  const [outputError, setOutputError] = useState<string | null>(null);
  const [wrongQuestions, setWrongQuestions] = useState<WrongQuestion[]>([]);
  const [allResults, setAllResults] = useState<QuizResultData[]>([]);
  const [userHistory, setUserHistory] = useState<QuizResultData[]>([]);
  const [startTime, setStartTime] = useState<Timestamp | null>(null);
  const [dueQuestions, setDueQuestions] = useState<PersistentWrongQuestion[]>([]);
  const [currentDueId, setCurrentDueId] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<QuizResultData | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [isWhitelisted, setIsWhitelisted] = useState<boolean | null>(null);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [newWhitelistEmail, setNewWhitelistEmail] = useState('');
  const [questionCounts, setQuestionCounts] = useState<Record<string, Record<string, number>>>({});
  const [isAddingToWhitelist, setIsAddingToWhitelist] = useState(false);
  const [isBulkGenerating, setIsBulkGenerating] = useState(false);
  const [bulkGenStatus, setBulkGenStatus] = useState<string>('');
  const [bulkGenSelectedTopics, setBulkGenSelectedTopics] = useState<string[]>([]);
  const [quotaError, setQuotaError] = useState<boolean>(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const totalQuestionsInDatabase = Object.values(questionCounts).reduce((acc, topicCounts) => {
    return acc + Object.values(topicCounts).reduce((a, b) => a + b, 0);
  }, 0);

  const { runCode, lintCode, isLoading: pyodideLoading } = usePyodide();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  function handleEditorDidMount(editor: any, monaco: any) {
    editorRef.current = editor;
    monacoRef.current = monaco;
  }

  useEffect(() => {
    const lint = async () => {
      if (editorRef.current && monacoRef.current && code) {
        const errors = await lintCode(code);
        const markers = errors.map((err: any) => ({
          startLineNumber: err.line,
          startColumn: err.column,
          endLineNumber: err.line,
          endColumn: err.column + 100,
          message: err.message,
          severity: monacoRef.current.MarkerSeverity.Error,
        }));
        monacoRef.current.editor.setModelMarkers(editorRef.current.getModel(), 'python', markers);
      }
    };

    const timeout = setTimeout(lint, 500);
    return () => clearTimeout(timeout);
  }, [code, lintCode]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const userEmail = u.email?.toLowerCase();
        if (userEmail === MASTER_EMAIL.toLowerCase()) {
          setIsWhitelisted(true);
        } else {
          // Check whitelist
          try {
            const q = query(collection(db, 'whitelist'), where('email', '==', userEmail));
            const snapshot = await getDocs(q);
            setIsWhitelisted(!snapshot.empty);
          } catch (e) {
            console.error("Whitelist check failed", e);
            setIsWhitelisted(false);
          }
        }
      } else {
        setIsWhitelisted(null);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || isWhitelisted !== true) return;

    // Listeners for all whitelisted users (e.g. question counts for start screen)
    const qCounts = query(collection(db, 'questions'));
    const unsubscribeCounts = onSnapshot(qCounts, (snapshot) => {
      const counts: Record<string, Record<string, number>> = {};
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        const topic = data.topic;
        const diff = data.difficulty;
        if (!counts[topic]) counts[topic] = { "Easy": 0, "Medium": 0, "Hard": 0 };
        counts[topic][diff] = (counts[topic][diff] || 0) + 1;
      });
      setQuestionCounts(counts);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'questions'));

    // Listeners for Master Dashboard
    let unsubscribeResults: () => void = () => {};
    let unsubscribePool: () => void = () => {};
    let unsubscribeWhitelist: () => void = () => {};

    if (user.email === MASTER_EMAIL && state === 'DASHBOARD') {
      const qResults = query(collection(db, 'results'), orderBy('timestamp', 'desc'));
      unsubscribeResults = onSnapshot(qResults, (snapshot) => {
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as QuizResultData));
        setAllResults(results);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'results'));

      const qPool = query(collection(db, 'questions'));
      unsubscribePool = onSnapshot(qPool, (snapshot) => {
        setPoolSize(snapshot.size);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'questions'));

      const qWhitelist = query(collection(db, 'whitelist'), orderBy('email'));
      unsubscribeWhitelist = onSnapshot(qWhitelist, (snapshot) => {
        setWhitelist(snapshot.docs.map(doc => doc.data().email));
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'whitelist'));
    }

    return () => {
      unsubscribeCounts();
      unsubscribeResults();
      unsubscribePool();
      unsubscribeWhitelist();
    };
  }, [user, isWhitelisted, state]);

  // Background Question Enricher
  useEffect(() => {
    if (!user) return;

    const enrichPool = async () => {
      // Only enrich if we are in START or DASHBOARD state (not during quiz to save resources)
      if (state !== 'START' && state !== 'DASHBOARD') return;

      // Pick a random topic and difficulty
      const randomTopic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
      const randomDifficulty = DIFFICULTIES[Math.floor(Math.random() * DIFFICULTIES.length)];

      console.log(`Background Enricher: Generating question for ${randomTopic} (${randomDifficulty})`);
      try {
        // Calling generateQuestion will automatically save to pool if it's a fresh generation
        // But since generateQuestion now checks pool first, we might just be fetching.
        // To truly "enrich", we should probably have a way to force generation or just let it happen naturally.
        // Actually, generateQuestion is fine because if it's not in pool, it generates.
        // If it IS in pool, it just fetches. 
        // Maybe we should just let it be, or explicitly call a "forceGenerate" if we wanted.
        // For now, natural usage + prefetching is already enriching.
        // Let's just add a small interval that triggers a generation if the pool is small.
        await generateQuestion([randomTopic], randomDifficulty);
      } catch (e) {
        console.error("Background enrichment failed", e);
      }
    };

    // Enrich every 10 minutes if active (reduced from 2 mins to avoid quota issues)
    const interval = setInterval(enrichPool, 600000);
    return () => clearInterval(interval);
  }, [user, state]);

  // Bulk Generator Logic
  useEffect(() => {
    if (!isBulkGenerating || !user || user.email !== MASTER_EMAIL) return;

    let isMounted = true;
    const runBulkGen = async () => {
      // Prioritize selected topics, then the rest
      const prioritizedTopics = bulkGenSelectedTopics.length > 0 
        ? [...bulkGenSelectedTopics, ...TOPICS.filter(t => !bulkGenSelectedTopics.includes(t))]
        : TOPICS;
        
      const targetCount = 1000;

      for (const topic of prioritizedTopics) {
        for (const diff of DIFFICULTIES) {
          // Re-check counts from the state which is updated by onSnapshot
          const currentCount = questionCounts[topic]?.[diff] || 0;
          
          if (currentCount < targetCount) {
            if (!isMounted) return;
            setBulkGenStatus(`Generating: ${topic} (${diff}) - ${currentCount}/${targetCount}`);
            try {
              await generateQuestion([topic], diff, undefined, true);
              // Wait 5 seconds between generations (increased from 3s to be safer)
              await new Promise(resolve => setTimeout(resolve, 5000));
              // We return here to let the next effect cycle handle it with fresh questionCounts
              // This ensures we don't over-generate if the snapshot is slow
              return; 
            } catch (e: any) {
              if (e.status === 429) {
                setBulkGenStatus(`Rate limited. Waiting 30s...`);
                await new Promise(resolve => setTimeout(resolve, 30000));
              } else {
                console.error("Bulk generation error", e);
                await new Promise(resolve => setTimeout(resolve, 10000));
              }
              return;
            }
          }
        }
      }
      setBulkGenStatus('All targets reached for prioritized topics!');
      setIsBulkGenerating(false);
    };

    const timeout = setTimeout(runBulkGen, 1000);
    return () => {
      isMounted = false;
      clearTimeout(timeout);
    };
  }, [isBulkGenerating, user, questionCounts, bulkGenSelectedTopics]);

  useEffect(() => {
    if (user && state === 'HISTORY') {
      const q = query(
        collection(db, 'results'), 
        where('userId', '==', user.uid),
        orderBy('timestamp', 'desc')
      );
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as QuizResultData));
        setUserHistory(results);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'results'));
      return () => unsubscribe();
    }
  }, [user, state]);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
        // User closed the popup or another request was made, ignore
        return;
      }
      if (error.code === 'auth/popup-blocked') {
        alert("Login popup was blocked by your browser. Please allow popups for this site to sign in.");
        return;
      }
      console.error("Login failed", error);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const addToWhitelist = async () => {
    if (!newWhitelistEmail || !newWhitelistEmail.includes('@')) {
      alert("Please enter a valid email address.");
      return;
    }
    const email = newWhitelistEmail.toLowerCase().trim();
    setIsAddingToWhitelist(true);
    try {
      await setDoc(doc(db, 'whitelist', email), {
        email,
        addedBy: user?.uid,
        addedAt: Timestamp.now()
      });
      
      // Send notification email via backend
      let emailSent = false;
      let emailError = "";
      try {
        const response = await fetch('/api/send-whitelist-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, addedBy: user?.uid })
        });
        
        const result = await response.json();
        if (response.ok && result.success) {
          emailSent = true;
        } else {
          emailError = result.details || result.error || "Unknown error";
          console.error("Email API error:", result);
        }
      } catch (emailErr) {
        console.error("Failed to send notification email", emailErr);
        emailError = "Network error or server failure.";
      }

      setNewWhitelistEmail('');
      if (emailSent) {
        alert(`Successfully added ${email} to whitelist. An invitation email has been sent.`);
      } else {
        alert(`Successfully added ${email} to whitelist, but the invitation email could not be sent.\n\nReason: ${emailError}`);
      }
    } catch (e: any) {
      console.error("Failed to add to whitelist", e);
      alert(`Error adding to whitelist: ${e.message}`);
    } finally {
      setIsAddingToWhitelist(false);
    }
  };

  const removeFromWhitelist = async (email: string) => {
    try {
      await deleteDoc(doc(db, 'whitelist', email));
    } catch (e) {
      console.error("Failed to remove from whitelist", e);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setState('START');
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const handleStart = async () => {
    if (!user) {
      handleLogin();
      return;
    }
    if (selectedTopics.length === 0) {
      alert("Please select at least one topic!");
      return;
    }

    setLoading(true);
    try {
      // Fetch due questions (wrong questions from > 24h ago)
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
      const cutoff = Timestamp.fromDate(twentyFourHoursAgo);
      
      const q = query(
        collection(db, 'wrongQuestions'),
        where('userId', '==', user.uid),
        where('isResolved', '==', false)
      );
      
      let snapshot;
      try {
        snapshot = await getDocs(q);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'wrongQuestions');
        return;
      }
      
      const due = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as PersistentWrongQuestion))
        .filter(q => 
          q.lastWrongTimestamp.toMillis() <= cutoff.toMillis() && 
          selectedTopics.includes(q.topic)
        );
      
      setDueQuestions(due);
      
      setState('QUIZ');
      setScore(0);
      setTotalQuestions(0);
      setWrongQuestions([]);
      setStartTime(Timestamp.now());
      
      // Start fetching questions
      await fetchNextQuestion(due);
    } catch (error) {
      console.error("Failed to start quiz", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchNextQuestion = async (initialDue?: PersistentWrongQuestion[]) => {
    if (totalQuestions >= targetQuestionCount) {
      finishQuiz();
      return;
    }

    setSelectedAnswer(null);
    setIsCorrect(null);
    setOutput('');
    setOutputError(null);

    // Check if we have a due question to ask
    const currentDue = initialDue || dueQuestions;
    if (currentDue.length > 0) {
      const nextDue = currentDue[0];
      setCurrentQuestion(nextDue.questionData);
      setCurrentDueId(nextDue.id);
      setCode(nextDue.questionData.codeSnippet || '# Write your code here\nprint("Hello Python!")');
      setDueQuestions(currentDue.slice(1));
      prefetchNext();
      return;
    }

    setCurrentDueId(null);

    if (nextQuestion) {
      setCurrentQuestion(nextQuestion);
      setCode(nextQuestion.codeSnippet || '# Write your code here\nprint("Hello Python!")');
      setNextQuestion(null);
      setQuotaError(false);
      prefetchNext();
      return;
    }

    // If no prefetch, try to get from pool quickly without loading screen
    if (user) {
      const poolQ = await getQuestionFromPool(selectedTopics, difficulty, user.uid);
      if (poolQ) {
        setCurrentQuestion(poolQ);
        setCode(poolQ.codeSnippet || '# Write your code here\nprint("Hello Python!")');
        setQuotaError(false);
        prefetchNext();
        return;
      }
    }

    // If pool also empty, show loading and generate/fallback
    setLoading(true);
    setQuotaError(false);
    try {
      const q = await generateQuestion(selectedTopics, difficulty, user?.uid);
      setCurrentQuestion(q);
      setCode(q.codeSnippet || '# Write your code here\nprint("Hello Python!")');
      prefetchNext();
    } catch (error: any) {
      console.error(error);
      if (error.status === 429 || error.message?.includes('quota')) {
        setQuotaError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const prefetchNext = async () => {
    if (totalQuestions + 1 >= targetQuestionCount) return;
    try {
      const q = await generateQuestion(selectedTopics, difficulty, user?.uid);
      setNextQuestion(q);
    } catch (error) {
      console.error("Prefetch failed", error);
    }
  };

  const handleAnswer = async (index: number) => {
    if (selectedAnswer !== null) return;
    setSelectedAnswer(index);
    const correct = index === currentQuestion?.correctAnswerIndex;
    setIsCorrect(correct);
    
    if (correct) {
      setScore(s => s + 1);
      // If this was a due question, mark it as resolved
      if (currentDueId) {
        try {
          await updateDoc(doc(db, 'wrongQuestions', currentDueId), {
            isResolved: true
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, 'wrongQuestions');
        }
      }
    } else if (currentQuestion) {
      const wrong: WrongQuestion = {
        question: currentQuestion.question,
        codeSnippet: currentQuestion.codeSnippet,
        userAnswer: currentQuestion.options[index],
        correctAnswer: currentQuestion.options[currentQuestion.correctAnswerIndex],
        explanation: currentQuestion.explanation,
        topic: currentQuestion.topic
      };
      setWrongQuestions(prev => [...prev, wrong]);

      // Save to persistent wrong questions for spaced repetition
      if (user) {
        try {
          await addDoc(collection(db, 'wrongQuestions'), {
            userId: user.uid,
            topic: currentQuestion.topic,
            questionData: currentQuestion,
            lastWrongTimestamp: Timestamp.now(),
            isResolved: false
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, 'wrongQuestions');
        }
      }
    }

    // Save to user question history to avoid repetition
    if (user && currentQuestion) {
      try {
        // Use a composite ID or just add a new record. 
        // Better to use setDoc with a composite ID to update existing history for this question
        const historyId = `${user.uid}_${currentQuestion.id}`;
        await setDoc(doc(db, 'userQuestionHistory', historyId), {
          userId: user.uid,
          questionId: currentQuestion.id,
          topic: currentQuestion.topic,
          difficulty: difficulty,
          lastAsked: Timestamp.now(),
          isCorrect: correct
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, 'userQuestionHistory');
      }
    }

    setTotalQuestions(t => t + 1);
    
    // Prefetch for the next question while user reads explanation
    prefetchNext();
  };

  const finishQuiz = async () => {
    setLoading(true);
    const percentage = Math.round((score / totalQuestions) * 100);
    const result: QuizResultData = {
      userId: user?.uid || 'anonymous',
      username: user?.displayName || 'Anonymous',
      score,
      totalQuestions,
      percentage,
      difficulty,
      topics: selectedTopics,
      wrongQuestions,
      timestamp: Timestamp.now(),
      startTime,
      endTime: Timestamp.now()
    };

    try {
      await addDoc(collection(db, 'results'), result);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'results');
    } finally {
      setLoading(false);
      setState('RESULT');
    }
  };

  const handleRunCode = async () => {
    const result = await runCode(code);
    setOutput(result.output);
    setOutputError(result.error);
  };

  const toggleTopic = (topic: string) => {
    setSelectedTopics(prev => 
      prev.includes(topic) ? prev.filter(t => t !== topic) : [...prev, topic]
    );
  };

  const handleHome = () => {
    setState('START');
    setScore(0);
    setTotalQuestions(0);
    setSelectedTopics([]);
    setCurrentQuestion(null);
    setWrongQuestions([]);
    setNextQuestion(null);
  };

  const handleTryAgain = () => {
    handleStart();
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans flex items-center justify-center p-6 overflow-hidden relative">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,#3a1510_0%,transparent_60%)] opacity-50" />
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-zinc-900/50 backdrop-blur-3xl border border-zinc-800 p-12 rounded-[3rem] text-center space-y-8 relative z-10"
        >
          <div className="w-24 h-24 bg-orange-500 rounded-full flex items-center justify-center mx-auto mb-4">
            <Code2 className="w-12 h-12 text-black" />
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-black tracking-tighter uppercase italic">Python Tutor</h1>
            <p className="text-zinc-500 font-medium uppercase tracking-widest text-xs">Student Support Platform</p>
          </div>
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-white text-black font-black py-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-orange-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoggingIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Play className="w-5 h-5" />
            )}
            {isLoggingIn ? 'SIGNING IN...' : 'SIGN IN WITH GOOGLE'}
          </button>
        </motion.div>
      </div>
    );
  }

  if (isWhitelisted === false) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-zinc-900 border border-zinc-800 p-12 rounded-[3rem] text-center space-y-8"
        >
          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto">
            <XCircle className="w-10 h-10 text-red-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-3xl font-black tracking-tighter uppercase italic">Access Denied</h2>
            <p className="text-zinc-500 text-sm">Your email ({user.email}) is not on the authorized list. Please contact the administrator for access.</p>
          </div>
          <button 
            onClick={() => signOut(auth)}
            className="w-full bg-zinc-800 text-white font-bold py-4 rounded-2xl hover:bg-zinc-700 transition-colors"
          >
            SIGN OUT
          </button>
        </motion.div>
      </div>
    );
  }

  if (isWhitelisted === null) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-orange-500 animate-spin" />
      </div>
    );
  }

  if (state === 'START') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-12"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-4">
                <div className="flex items-center gap-6">
                  <h1 className="text-7xl font-black tracking-tighter uppercase italic text-orange-500">
                    Python Mastery
                  </h1>
                  <div className="bg-orange-500/10 border border-orange-500/20 px-6 py-3 rounded-[2rem] backdrop-blur-xl">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-orange-500/60 mb-1">Database Pool</p>
                    <div className="flex items-baseline gap-2">
                      <p className="text-4xl font-black text-orange-500 tabular-nums leading-none">{totalQuestionsInDatabase}</p>
                      <p className="text-xs font-bold text-orange-500/40 uppercase tracking-tighter">Questions</p>
                    </div>
                  </div>
                </div>
                <p className="text-zinc-400 text-lg font-medium">Interactive Learning & Assessment Platform</p>
              </div>
              <div className="flex items-center gap-4">
                {user && (
                  <button 
                    onClick={() => setState('HISTORY')}
                    className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-colors"
                  >
                    <History className="w-4 h-4" />
                    My History
                  </button>
                )}
                {user?.email === MASTER_EMAIL && (
                  <button 
                    onClick={() => setState('DASHBOARD')}
                    className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-colors"
                  >
                    <LayoutDashboard className="w-4 h-4" />
                    Master Dashboard
                  </button>
                )}
                {user ? (
                  <div className="flex items-center gap-4 bg-zinc-900 p-2 pr-4 rounded-2xl border border-zinc-800">
                    <img src={user.photoURL || ''} alt="" className="w-10 h-10 rounded-xl" referrerPolicy="no-referrer" />
                    <div>
                      <p className="text-xs font-bold uppercase tracking-tighter">{user.displayName}</p>
                      <button onClick={handleLogout} className="text-[10px] text-zinc-500 hover:text-orange-500 flex items-center gap-1 uppercase font-bold tracking-widest">
                        <LogOut className="w-3 h-3" /> Logout
                      </button>
                    </div>
                  </div>
                ) : (
                  <button 
                    onClick={handleLogin}
                    className="bg-white text-black px-6 py-3 rounded-2xl font-black text-sm uppercase tracking-tighter hover:bg-orange-500 transition-colors"
                  >
                    Login with Google
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-8">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-500">1. Select Topics</label>
                    <button 
                      onClick={() => setSelectedTopics(selectedTopics.length === TOPICS.length ? [] : [...TOPICS])}
                      className="text-[10px] font-bold uppercase tracking-widest text-orange-500 hover:text-white transition-colors"
                    >
                      {selectedTopics.length === TOPICS.length ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {TOPICS.map(topic => (
                      <button
                        key={topic}
                        onClick={() => toggleTopic(topic)}
                        className={cn(
                          "flex items-center justify-between p-4 rounded-xl border transition-all text-left group",
                          selectedTopics.includes(topic) 
                            ? "bg-orange-500 border-orange-500 text-black shadow-lg shadow-orange-500/20" 
                            : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                        )}
                      >
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shrink-0",
                            selectedTopics.includes(topic) ? "bg-black border-black" : "border-zinc-700 bg-black/20"
                          )}>
                            {selectedTopics.includes(topic) && <CheckCircle2 className="w-3 h-3 text-orange-500" />}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-bold text-sm">{topic}</span>
                            <span className={cn(
                              "text-[10px] font-mono mt-1",
                              selectedTopics.includes(topic) ? "text-black/60" : "text-zinc-600"
                            )}>
                              {questionCounts[topic] 
                                ? `${questionCounts[topic]["Easy"] || 0}/${questionCounts[topic]["Medium"] || 0}/${questionCounts[topic]["Hard"] || 0}`
                                : "0/0/0"}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-8">
                <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-8">
                  <div className="space-y-4">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-500">2. Difficulty</label>
                    <div className="flex gap-2">
                      {DIFFICULTIES.map(d => (
                        <button
                          key={d}
                          onClick={() => setDifficulty(d)}
                          className={cn(
                            "flex-1 py-3 rounded-xl border text-xs font-bold uppercase tracking-widest transition-all",
                            difficulty === d ? "bg-white text-black border-white" : "bg-black border-zinc-800 text-zinc-500 hover:border-zinc-600"
                          )}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-500">3. Question Count</label>
                    <div className="flex gap-2">
                      {QUESTION_COUNTS.map(c => (
                        <button
                          key={c}
                          onClick={() => setTargetQuestionCount(c)}
                          className={cn(
                            "flex-1 py-3 rounded-xl border text-xs font-bold uppercase tracking-widest transition-all",
                            targetQuestionCount === c ? "bg-white text-black border-white" : "bg-black border-zinc-800 text-zinc-500 hover:border-zinc-600"
                          )}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="pt-4">
                    <button 
                      onClick={handleStart}
                      className="w-full bg-orange-500 text-black font-black py-5 rounded-2xl flex items-center justify-center gap-2 hover:bg-white transition-colors group"
                    >
                      START ASSESSMENT
                      <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  if (state === 'QUIZ') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans flex flex-col">
        <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between bg-black/50 backdrop-blur-xl sticky top-0 z-50">
          <div className="flex items-center gap-4">
            <div className="bg-orange-500 p-2 rounded-lg">
              <Code2 className="w-5 h-5 text-black" />
            </div>
            <div>
              <h2 className="font-bold text-sm uppercase tracking-tighter">Python Mastery</h2>
              <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">
                {user?.displayName} • Q: {totalQuestions}/{targetQuestionCount} • Score: {score}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="h-1 w-32 bg-zinc-800 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-orange-500"
                initial={{ width: 0 }}
                animate={{ width: `${(totalQuestions / targetQuestionCount) * 100}%` }}
              />
            </div>
            <button 
              onClick={() => setState('RESULT')}
              className="text-xs font-bold uppercase tracking-widest text-zinc-500 hover:text-white transition-colors"
            >
              Quit
            </button>
          </div>
        </header>

        <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 overflow-hidden">
          <div className="p-8 overflow-y-auto border-r border-zinc-800 custom-scrollbar">
            <AnimatePresence mode="wait">
              {loading ? (
                <motion.div 
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="h-full flex flex-col items-center justify-center space-y-4"
                >
                  <Loader2 className="w-12 h-12 text-orange-500 animate-spin" />
                  <p className="text-zinc-500 font-mono text-xs uppercase tracking-widest">Generating Challenge...</p>
                </motion.div>
              ) : quotaError ? (
                <motion.div 
                  key="quota-error"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="h-full flex flex-col items-center justify-center space-y-8 text-center p-6"
                >
                  <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center">
                    <BrainCircuit className="w-10 h-10 text-red-500" />
                  </div>
                  <div className="space-y-4 max-w-md">
                    <h2 className="text-3xl font-black tracking-tighter uppercase italic text-red-500">Quota Exceeded</h2>
                    <p className="text-zinc-400 text-sm leading-relaxed">
                      The AI has reached its temporary limit for generating new questions. 
                      This usually happens when the question pool for your selected topic is empty and the API is busy.
                    </p>
                    <div className="bg-black/50 border border-zinc-800 p-4 rounded-2xl text-left">
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">How to fix:</p>
                      <ul className="text-xs text-zinc-400 space-y-2 list-disc pl-4">
                        <li>Wait a few minutes and try again.</li>
                        <li>Try selecting a different topic that might have questions in the pool.</li>
                        <li>Ask the administrator to run the Bulk Generator.</li>
                      </ul>
                    </div>
                  </div>
                  <div className="flex flex-col w-full max-w-xs gap-3">
                    <button 
                      onClick={() => fetchNextQuestion()}
                      className="w-full bg-white text-black font-black py-4 rounded-2xl hover:bg-orange-500 transition-colors flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4" />
                      RETRY GENERATION
                    </button>
                    <button 
                      onClick={() => {
                        setQuotaError(false);
                        setState('START');
                      }}
                      className="w-full bg-zinc-900 text-white font-bold py-4 rounded-2xl hover:bg-zinc-800 transition-colors"
                    >
                      BACK TO MENU
                    </button>
                  </div>
                </motion.div>
              ) : currentQuestion && (
                <motion.div 
                  key={currentQuestion.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="space-y-8"
                >
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <span className="px-3 py-1 bg-zinc-800 text-zinc-400 text-[10px] font-bold uppercase tracking-widest rounded-full">
                        {currentQuestion.topic}
                      </span>
                      <span className="px-3 py-1 bg-orange-500/10 text-orange-500 text-[10px] font-bold uppercase tracking-widest rounded-full border border-orange-500/20">
                        {difficulty}
                      </span>
                      {user?.email === MASTER_EMAIL && (
                        <button
                          onClick={async () => {
                            if (currentQuestion && window.confirm('Are you sure you want to delete this question from the pool?')) {
                              try {
                                await deleteDoc(doc(db, 'questions', currentQuestion.id));
                                fetchNextQuestion();
                              } catch (e) {
                                console.error("Delete failed", e);
                              }
                            }
                          }}
                          className="p-1.5 bg-red-500/10 text-red-500 rounded-full hover:bg-red-500 hover:text-white transition-all"
                          title="Delete from Pool"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <h3 className="text-2xl font-bold leading-snug whitespace-pre-wrap">
                      {currentQuestion.question}
                    </h3>
                  </div>

                  <div className="space-y-2">
                    {currentQuestion.options.map((option, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleAnswer(idx)}
                        disabled={selectedAnswer !== null}
                        className={cn(
                          "w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between group text-sm",
                          selectedAnswer === null 
                            ? "bg-zinc-900 border-zinc-800 hover:border-zinc-600" 
                            : idx === currentQuestion.correctAnswerIndex
                              ? "bg-green-500/20 border-green-500 text-green-400"
                              : selectedAnswer === idx
                                ? "bg-red-500/20 border-red-500 text-red-400"
                                : "bg-zinc-900/50 border-zinc-800 text-zinc-600"
                        )}
                      >
                        <span className="font-medium">{option}</span>
                        {selectedAnswer !== null && idx === currentQuestion.correctAnswerIndex && (
                          <CheckCircle2 className="w-4 h-4" />
                        )}
                        {selectedAnswer === idx && idx !== currentQuestion.correctAnswerIndex && (
                          <XCircle className="w-4 h-4" />
                        )}
                      </button>
                    ))}
                  </div>

                  {selectedAnswer !== null && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-3"
                    >
                      <div className="flex items-center gap-2 text-orange-500">
                        <BrainCircuit className="w-4 h-4" />
                        <span className="text-[10px] font-bold uppercase tracking-widest">Explanation</span>
                      </div>
                      <p className="text-zinc-400 text-xs leading-relaxed whitespace-pre-wrap">
                        {currentQuestion.explanation}
                      </p>
                      <button 
                        onClick={fetchNextQuestion}
                        className="w-full bg-white text-black font-bold py-3 rounded-xl hover:bg-orange-500 transition-colors text-sm"
                      >
                        {totalQuestions >= targetQuestionCount ? 'Finish Assessment' : 'Next Question'}
                      </button>
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="flex flex-col bg-[#050505]">
            <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-zinc-500" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Interactive Sandbox</span>
              </div>
              <button 
                onClick={handleRunCode}
                disabled={pyodideLoading}
                className="flex items-center gap-2 bg-orange-500 text-black px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-tighter hover:bg-white transition-colors disabled:opacity-50"
              >
                {pyodideLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                Run Script
              </button>
            </div>
            
            <div className="flex-1 min-h-[300px]">
              <Editor
                height="100%"
                defaultLanguage="python"
                theme="vs-dark"
                value={code}
                onChange={(val) => setCode(val || '')}
                onMount={handleEditorDidMount}
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  fontFamily: 'JetBrains Mono, monospace',
                  padding: { top: 20 },
                  scrollBeyondLastLine: false,
                  lineNumbers: 'on',
                  roundedSelection: false,
                  readOnly: false,
                  cursorStyle: 'line',
                  automaticLayout: true,
                  wordWrap: 'on',
                }}
              />
            </div>

            <div className="h-48 border-t border-zinc-800 bg-black p-4 font-mono text-xs overflow-y-auto custom-scrollbar">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-zinc-800" />
                <span className="text-[10px] uppercase tracking-widest text-zinc-600 font-bold">Output Console</span>
              </div>
              <div className="space-y-1">
                {outputError ? (
                  outputError.split('\n').map((line, i) => {
                    const isTraceback = line.includes('Traceback') || line.includes('File "<string>"');
                    const isErrorLine = line.includes('Error:');
                    return (
                      <div key={i} className="flex gap-4 group">
                        <span className="text-zinc-800 w-6 text-right select-none font-mono text-[10px] pt-0.5">{i + 1}</span>
                        <span className={cn(
                          "whitespace-pre-wrap",
                          isTraceback ? "text-zinc-500 italic" : 
                          isErrorLine ? "text-red-400 font-bold" : "text-red-500"
                        )}>
                          {line}
                        </span>
                      </div>
                    );
                  })
                ) : output ? (
                  output.split('\n').map((line, i) => (
                    <div key={i} className="flex gap-4 group">
                      <span className="text-zinc-800 w-6 text-right select-none font-mono text-[10px] pt-0.5">{i + 1}</span>
                      <span className="text-zinc-300 whitespace-pre-wrap">{line}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-zinc-600 italic pl-10">No output yet. Run your code to see results.</p>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (state === 'RESULT') {
    const percentage = totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0;
    
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-4xl w-full bg-zinc-900 border border-zinc-800 p-12 rounded-[3rem] space-y-8"
        >
          <div className="text-center space-y-8">
            <div className="relative inline-block">
              <div className="w-32 h-32 bg-orange-500 rounded-full flex items-center justify-center mx-auto">
                <Trophy className="w-16 h-16 text-black" />
              </div>
              <motion.div 
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.3 }}
                className="absolute -top-2 -right-2 bg-white text-black w-12 h-12 rounded-full flex items-center justify-center font-black text-xs"
              >
                {percentage}%
              </motion.div>
            </div>

            <div className="space-y-2">
              <h2 className="text-4xl font-black tracking-tighter uppercase italic">Assessment Complete</h2>
              <p className="text-zinc-500 font-medium">Great work, {user?.displayName}!</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-black/50 p-6 rounded-3xl border border-zinc-800">
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Correct</p>
                <p className="text-3xl font-black text-green-500">{score}</p>
              </div>
              <div className="bg-black/50 p-6 rounded-3xl border border-zinc-800">
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Total</p>
                <p className="text-3xl font-black text-white">{totalQuestions}</p>
              </div>
              <div className="bg-black/50 p-6 rounded-3xl border border-zinc-800">
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Difficulty</p>
                <p className="text-xl font-black text-orange-500 uppercase">{difficulty}</p>
              </div>
              <div className="bg-black/50 p-6 rounded-3xl border border-zinc-800">
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Accuracy</p>
                <p className="text-3xl font-black text-white">{percentage}%</p>
              </div>
            </div>
          </div>

          {wrongQuestions.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Review Mistakes</h3>
              <div className="space-y-3 max-h-60 overflow-y-auto custom-scrollbar pr-2">
                {wrongQuestions.map((q, idx) => (
                  <div key={idx} className="bg-black/30 border border-zinc-800 p-6 rounded-2xl space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <p className="font-bold text-sm whitespace-pre-wrap">{q.question}</p>
                      <span className="px-2 py-1 bg-zinc-800 rounded text-[8px] font-bold uppercase tracking-widest text-zinc-500 whitespace-nowrap">
                        {q.topic}
                      </span>
                    </div>
                    
                    {q.codeSnippet && (
                      <div className="p-4 bg-black/50 border border-zinc-800 rounded-xl font-mono text-[10px] leading-relaxed text-zinc-300 overflow-x-auto custom-scrollbar">
                        <pre className="whitespace-pre-wrap">{q.codeSnippet}</pre>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 text-[10px] font-mono uppercase tracking-widest">
                      <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                        <p className="text-red-500/50 mb-1">Your Answer</p>
                        <p className="text-red-400">{q.userAnswer}</p>
                      </div>
                      <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-xl">
                        <p className="text-green-500/50 mb-1">Correct Answer</p>
                        <p className="text-green-400">{q.correctAnswer}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
            <button 
              onClick={handleHome}
              className="bg-zinc-900 text-white font-black py-5 rounded-2xl flex items-center justify-center gap-2 hover:bg-zinc-800 transition-colors border border-zinc-800"
            >
              <LayoutDashboard className="w-5 h-5" />
              HOME
            </button>
            <button 
              onClick={handleTryAgain}
              className="bg-white text-black font-black py-5 rounded-2xl flex items-center justify-center gap-2 hover:bg-orange-500 transition-colors"
            >
              <RotateCcw className="w-5 h-5" />
              TRY AGAIN
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (state === 'DASHBOARD' || state === 'HISTORY') {
    const results = state === 'DASHBOARD' ? allResults : userHistory;
    const title = state === 'DASHBOARD' ? "Master Dashboard" : "My Quiz History";
    const subtitle = state === 'DASHBOARD' ? "Global Performance Tracking" : "Your Past Performance";

    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans p-8">
        <div className="max-w-6xl mx-auto space-y-12">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <h1 className="text-5xl font-black tracking-tighter uppercase italic text-orange-500">{title}</h1>
              <p className="text-zinc-500 text-sm font-bold uppercase tracking-widest">{subtitle}</p>
            </div>
            <div className="flex items-center gap-4">
              {state === 'DASHBOARD' && (
                <div className="bg-zinc-900 border border-zinc-800 px-6 py-3 rounded-2xl flex items-center gap-3">
                  <BrainCircuit className="w-5 h-5 text-orange-500" />
                  <div className="text-left">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Pool Size</p>
                    <p className="text-lg font-black">{poolSize}</p>
                  </div>
                </div>
              )}
              <button 
                onClick={() => setState('START')}
                className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 px-6 py-3 rounded-2xl text-xs font-bold uppercase tracking-widest transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Back to App
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {state === 'DASHBOARD' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-[3rem] space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-black uppercase tracking-tighter italic">Authorized Users (Whitelist)</h3>
                    <div className="flex items-center gap-3">
                      <input 
                        type="email" 
                        placeholder="Enter email to authorize..."
                        value={newWhitelistEmail}
                        onChange={(e) => setNewWhitelistEmail(e.target.value)}
                        className="bg-black border border-zinc-800 px-4 py-2 rounded-xl text-sm focus:border-orange-500 outline-none w-64"
                      />
                      <button 
                        onClick={addToWhitelist}
                        disabled={isAddingToWhitelist}
                        className="bg-white text-black px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-orange-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {isAddingToWhitelist && <Loader2 className="w-3 h-3 animate-spin" />}
                        {isAddingToWhitelist ? 'Adding...' : 'Add User'}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {whitelist.map(email => (
                      <div key={email} className="bg-black/50 border border-zinc-800 px-4 py-2 rounded-xl flex items-center gap-3 group">
                        <span className="text-xs font-bold text-zinc-400">{email}</span>
                        <button 
                          onClick={() => removeFromWhitelist(email)}
                          className="text-zinc-600 hover:text-red-500 transition-colors"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    {whitelist.length === 0 && <p className="text-zinc-600 text-xs font-bold uppercase tracking-widest">No additional users authorized.</p>}
                  </div>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-[3rem] space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <h3 className="text-xl font-black uppercase tracking-tighter italic">Bulk Question Generator</h3>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Target: 1000 Questions per Difficulty</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2 bg-black/30 px-4 py-2 rounded-xl border border-zinc-800">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Priority Topics:</span>
                        <span className="text-xs font-black text-orange-500">{bulkGenSelectedTopics.length || 'All'}</span>
                      </div>
                      <button 
                        onClick={() => setIsBulkGenerating(!isBulkGenerating)}
                        className={cn(
                          "px-6 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2",
                          isBulkGenerating 
                            ? "bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500 hover:text-white" 
                            : "bg-orange-500 text-black hover:bg-white"
                        )}
                      >
                        {isBulkGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        {isBulkGenerating ? 'Stop Generator' : 'Start Generator'}
                      </button>
                    </div>
                  </div>
                  
                  {isBulkGenerating && (
                    <div className={cn(
                      "border p-4 rounded-2xl flex items-center gap-4 transition-all",
                      bulkGenStatus.includes('limited') 
                        ? "bg-red-500/10 border-red-500/30 text-red-500" 
                        : "bg-black/50 border-zinc-800 text-orange-500"
                    )}>
                      <div className={cn(
                        "w-2 h-2 rounded-full animate-pulse",
                        bulkGenStatus.includes('limited') ? "bg-red-500" : "bg-orange-500"
                      )} />
                      <p className="text-xs font-mono uppercase tracking-widest">{bulkGenStatus}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {TOPICS.map(topic => {
                      const isSelected = bulkGenSelectedTopics.includes(topic);
                      return (
                        <div 
                          key={topic} 
                          className={cn(
                            "p-6 rounded-[2rem] border transition-all cursor-pointer group",
                            isSelected 
                              ? "bg-orange-500/5 border-orange-500/30" 
                              : "bg-black/20 border-zinc-800/50 hover:border-zinc-700"
                          )}
                          onClick={() => {
                            setBulkGenSelectedTopics(prev => 
                              prev.includes(topic) ? prev.filter(t => t !== topic) : [...prev, topic]
                            );
                          }}
                        >
                          <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all",
                                isSelected ? "border-orange-500 bg-orange-500" : "border-zinc-700"
                              )}>
                                {isSelected && <CheckCircle2 className="w-3 h-3 text-black" />}
                              </div>
                              <p className={cn(
                                "text-xs font-black uppercase tracking-tighter italic",
                                isSelected ? "text-orange-500" : "text-zinc-400"
                              )}>{topic}</p>
                            </div>
                            {isSelected && (
                              <span className="text-[9px] font-bold bg-orange-500 text-black px-2 py-0.5 rounded-full uppercase tracking-widest">Priority</span>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            {DIFFICULTIES.map(diff => {
                              const count = questionCounts[topic]?.[diff] || 0;
                              const progress = Math.min(100, (count / 1000) * 100);
                              return (
                                <div key={diff} className="bg-black/30 p-3 rounded-xl border border-zinc-800/50">
                                  <div className="flex justify-between items-baseline mb-1">
                                    <span className="text-[9px] font-bold text-zinc-600 uppercase">{diff}</span>
                                    <span className="text-xs font-black">{count}</span>
                                  </div>
                                  <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                                    <div 
                                      className={cn(
                                        "h-full transition-all duration-500",
                                        isSelected ? "bg-orange-500" : "bg-zinc-600"
                                      )}
                                      style={{ width: `${progress}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {results.length === 0 ? (
              <div className="text-center py-20 bg-zinc-900/30 rounded-[3rem] border border-zinc-800 border-dashed">
                <BarChart3 className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
                <p className="text-zinc-500 font-bold uppercase tracking-widest text-xs">No results recorded yet.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {results.map((res) => (
                  <motion.div 
                    key={res.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl flex flex-col md:flex-row md:items-center justify-between gap-6 hover:border-orange-500/50 transition-colors cursor-pointer"
                    onClick={() => setSelectedResult(res)}
                  >
                    <div className="flex items-center gap-6">
                      <div className="w-12 h-12 bg-orange-500/10 rounded-2xl flex items-center justify-center border border-orange-500/20">
                        <UserIcon className="w-6 h-6 text-orange-500" />
                      </div>
                      <div>
                        <h4 className="font-black uppercase tracking-tighter text-lg">{res.username}</h4>
                        <div className="flex flex-wrap items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {res.timestamp?.toDate().toLocaleDateString()}</span>
                          <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {res.timestamp?.toDate().toLocaleTimeString()}</span>
                          <span className="px-2 py-0.5 bg-zinc-800 rounded-full">{res.difficulty}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-8">
                      <div className="text-center">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Score</p>
                        <p className="text-xl font-black">{res.score}/{res.totalQuestions}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Accuracy</p>
                        <p className="text-xl font-black text-orange-500">{res.percentage}%</p>
                      </div>
                      <div className="text-center hidden sm:block">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Mistakes</p>
                        <p className="text-xl font-black text-red-500">{res.wrongQuestions?.length || 0}</p>
                      </div>
                      <Eye className="w-5 h-5 text-zinc-700" />
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </div>

        <AnimatePresence>
          {selectedResult && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-zinc-900 border border-zinc-800 w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-[3rem] flex flex-col"
              >
                <div className="p-8 border-b border-zinc-800 flex items-center justify-between">
                  <div className="space-y-1">
                    <h3 className="text-2xl font-black uppercase italic tracking-tighter">Quiz Details</h3>
                    <p className="text-xs text-zinc-500 font-bold uppercase tracking-widest">
                      {selectedResult.username} • {selectedResult.timestamp?.toDate().toLocaleString()}
                    </p>
                  </div>
                  <button 
                    onClick={() => setSelectedResult(null)}
                    className="p-2 hover:bg-zinc-800 rounded-full transition-colors"
                  >
                    <XCircle className="w-6 h-6" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="bg-black/50 p-4 rounded-2xl border border-zinc-800">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Score</p>
                      <p className="text-xl font-black">{selectedResult.score}/{selectedResult.totalQuestions}</p>
                    </div>
                    <div className="bg-black/50 p-4 rounded-2xl border border-zinc-800">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Accuracy</p>
                      <p className="text-xl font-black text-orange-500">{selectedResult.percentage}%</p>
                    </div>
                    <div className="bg-black/50 p-4 rounded-2xl border border-zinc-800">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Duration</p>
                      <p className="text-xl font-black">
                        {selectedResult.startTime && selectedResult.endTime 
                          ? `${Math.round((selectedResult.endTime.toDate().getTime() - selectedResult.startTime.toDate().getTime()) / 1000 / 60)} min`
                          : 'N/A'
                        }
                      </p>
                    </div>
                    <div className="bg-black/50 p-4 rounded-2xl border border-zinc-800">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Difficulty</p>
                      <p className="text-xl font-black uppercase text-orange-500">{selectedResult.difficulty}</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Topics Covered</h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedResult.topics.map(t => (
                        <span key={t} className="px-3 py-1 bg-zinc-800 rounded-full text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Mistakes ({selectedResult.wrongQuestions?.length || 0})</h4>
                    <div className="space-y-4">
                      {selectedResult.wrongQuestions?.map((q, idx) => (
                        <div key={idx} className="bg-black/30 border border-zinc-800 p-6 rounded-2xl space-y-4">
                          <div className="flex items-start justify-between gap-4">
                            <p className="font-bold text-sm whitespace-pre-wrap">{q.question}</p>
                            <span className="px-2 py-1 bg-zinc-800 rounded text-[8px] font-bold uppercase tracking-widest text-zinc-500 whitespace-nowrap">
                              {q.topic}
                            </span>
                          </div>
                          
                          {q.codeSnippet && (
                            <div className="p-4 bg-black/50 border border-zinc-800 rounded-xl font-mono text-[10px] leading-relaxed text-zinc-300 overflow-x-auto custom-scrollbar">
                              <pre className="whitespace-pre-wrap">{q.codeSnippet}</pre>
                            </div>
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[10px] font-mono uppercase tracking-widest">
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                              <p className="text-red-500/50 mb-1">Your Answer</p>
                              <p className="text-red-400">{q.userAnswer}</p>
                            </div>
                            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-xl">
                              <p className="text-green-500/50 mb-1">Correct Answer</p>
                              <p className="text-green-400">{q.correctAnswer}</p>
                            </div>
                          </div>
                          <div className="p-4 bg-zinc-800/50 rounded-xl space-y-2">
                            <div className="flex items-center gap-2 text-orange-500">
                              <BrainCircuit className="w-4 h-4" />
                              <span className="text-[10px] font-bold uppercase tracking-widest">Explanation</span>
                            </div>
                            <p className="text-zinc-400 text-xs leading-relaxed whitespace-pre-wrap">{q.explanation}</p>
                          </div>
                        </div>
                      ))}
                      {(!selectedResult.wrongQuestions || selectedResult.wrongQuestions.length === 0) && (
                        <div className="text-center py-8 bg-zinc-800/20 rounded-2xl border border-zinc-800 border-dashed">
                          <p className="text-zinc-500 text-xs font-bold uppercase tracking-widest">Perfect score! No mistakes to show.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return null;
}
