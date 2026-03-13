import { useState, useEffect, useRef, useCallback, ChangeEvent } from 'react';
import {
  LayoutDashboard,
  MessageSquare,
  Search,
  Plus,
  FileText,
  Send,
  Loader2,
  Clock,
  Briefcase,
  UploadCloud,
  Pencil,
  Trash2,
  FolderOpen,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Project, Message, FileMetadata } from './types';
import { chatWithAssistant } from './services/aiService';

// ── Toast ─────────────────────────────────────────────────────────────────────
type ToastKind = 'success' | 'error' | 'loading';
interface Toast { id: number; message: string; kind: ToastKind }

let _toastId = 0;
function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, kind: ToastKind = 'success', duration = 3500) => {
    const id = ++_toastId;
    setToasts(prev => [...prev, { id, message, kind }]);
    if (kind !== 'loading') {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    }
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, show, dismiss };
}

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl text-sm font-medium pointer-events-auto max-w-xs
              ${t.kind === 'error' ? 'bg-red-500 text-white' : 'bg-[#1A1A1A] text-white'}`}
          >
            {t.kind === 'loading' && <Loader2 size={16} className="animate-spin shrink-0" />}
            {t.kind === 'success' && <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />}
            {t.kind === 'error' && <XCircle size={16} className="shrink-0" />}
            <span>{t.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ── Text extensions whitelist ─────────────────────────────────────────────────
const TEXT_EXTS = new Set([
  '.ts','.tsx','.js','.jsx','.mjs','.cjs',
  '.md','.mdx','.json','.txt','.py','.java',
  '.c','.cpp','.h','.hpp','.cs','.go','.rs',
  '.rb','.php','.html','.css','.scss','.sass',
  '.sql','.yaml','.yml','.toml','.bat','.sh',
  '.env','.gitignore','.dockerfile','.vue','.svelte',
  '.xml','.graphql','.prisma',
]);

function isIndexable(file: File) {
  if (file.type.startsWith('text/')) return true;
  const lower = file.name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return true;
  const ext = lower.slice(lower.lastIndexOf('.'));
  return TEXT_EXTS.has(ext);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'chat'>('dashboard');
  const [projects, setProjects] = useState<Project[]>([]);
  const [fileCounts, setFileCounts] = useState<Record<number, number>>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [indexingProjectId, setIndexingProjectId] = useState<number | null>(null);
  const [indexingLabel, setIndexingLabel] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showEditProjectModal, setShowEditProjectModal] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [selectedProjectFiles, setSelectedProjectFiles] = useState<FileMetadata[]>([]);
  const [viewingProject, setViewingProject] = useState<Project | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [activeFeedMenu, setActiveFeedMenu] = useState<number | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toasts, show: toast, dismiss } = useToast();

  useEffect(() => { fetchProjects(); }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isTyping]);

  // ── Data fetching ───────────────────────────────────────────────────────────
  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data: Project[] = await res.json();
      setProjects(data);
      // Fetch file counts in parallel
      const counts = await Promise.all(
        data.map(async p => {
          const r = await fetch(`/api/projects/${p.id}/files`);
          const files = await r.json();
          return [p.id, files.length] as [number, number];
        })
      );
      setFileCounts(Object.fromEntries(counts));
    } catch (e) {
      console.error('Failed to fetch projects', e);
    }
  };

  // ── File processing ─────────────────────────────────────────────────────────
  const processFiles = async (files: FileList) => {
    const result = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!isIndexable(file)) continue;
      try {
        const content = await file.text();
        result.push({
          name: file.name,
          path: (file as any).webkitRelativePath || file.name,
          content: content.slice(0, 5000),
          lastModified: new Date(file.lastModified).toISOString(),
        });
      } catch { /* skip unreadable files */ }
    }
    return result;
  };

  // ── Unique project name ─────────────────────────────────────────────────────
  const uniqueProjectName = (base: string, existing: Project[]) => {
    const names = new Set(existing.map(p => p.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  };

  // ── Import folder → auto-create project ────────────────────────────────────
  const handleImportFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const inputEl = event.target; // hold ref for reset in finally

    const firstPath = (files[0] as any).webkitRelativePath as string;
    const baseName = firstPath ? firstPath.split('/')[0] : 'New Project';

    // Refresh projects list to get latest names for dedup
    let currentProjects = projects;
    try {
      const r = await fetch('/api/projects');
      currentProjects = await r.json();
    } catch { /* use cached */ }

    const projectName = uniqueProjectName(baseName, currentProjects);

    const loadingId = toast(`Creating project "${projectName}"…`, 'loading');

    try {
      // 1. Create project
      const createRes = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName, description: `Imported from folder: ${baseName}` }),
      });
      if (!createRes.ok) throw new Error('Failed to create project');
      const { id: projectId } = await createRes.json();

      // 2. Process files
      setIndexingProjectId(projectId);
      const filesToUpload = await processFiles(files);
      setIndexingLabel(`Indexing ${filesToUpload.length} files…`);

      if (filesToUpload.length === 0) {
        dismiss(loadingId);
        toast('No indexable text files found in that folder.', 'error');
        // Clean up empty project
        await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
        return;
      }

      // 3. Index
      await fetch('/api/files/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, files: filesToUpload }),
      });

      dismiss(loadingId);
      toast(`"${projectName}" created — ${filesToUpload.length} files indexed`, 'success');
      await fetchProjects();
    } catch (err: any) {
      dismiss(loadingId);
      toast(err.message || 'Failed to import folder', 'error');
    } finally {
      setIndexingProjectId(null);
      setIndexingLabel('');
      inputEl.value = ''; // reset here, after FileList is no longer needed
    }
  };

  // ── Add more files to existing project ─────────────────────────────────────
  const handleAddFiles = async (projectId: number, event: ChangeEvent<HTMLInputElement>, isFolder = false) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    event.target.value = '';
    setActiveFeedMenu(null);

    setIndexingProjectId(projectId);
    const filesToUpload = await processFiles(files);
    setIndexingLabel(`Indexing ${filesToUpload.length} files…`);

    if (filesToUpload.length === 0) {
      toast('No indexable files found.', 'error');
      setIndexingProjectId(null);
      return;
    }

    try {
      await fetch('/api/files/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, files: filesToUpload }),
      });
      toast(`Added ${filesToUpload.length} file${filesToUpload.length !== 1 ? 's' : ''}`, 'success');
      await fetchProjects();
    } catch {
      toast('Failed to index files', 'error');
    } finally {
      setIndexingProjectId(null);
      setIndexingLabel('');
    }
  };

  // ── Project mutations ───────────────────────────────────────────────────────
  const handleUpdateProject = async () => {
    if (!editingProject || !editProjectName.trim()) return;
    const res = await fetch(`/api/projects/${editingProject.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editProjectName, description: editingProject.description }),
    });
    if (res.ok) {
      setShowEditProjectModal(false);
      setEditingProject(null);
      toast('Project renamed', 'success');
      fetchProjects();
    } else {
      toast('Failed to rename — name might already exist', 'error');
    }
  };

  const handleDeleteProject = async (id: number) => {
    if (!confirm('Delete this project and all its indexed files?')) return;
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (res.ok) { toast('Project deleted', 'success'); fetchProjects(); }
  };

  const handleViewFiles = async (project: Project) => {
    setViewingProject(project);
    setFileSearchQuery('');
    const res = await fetch(`/api/projects/${project.id}/files`);
    setSelectedProjectFiles(await res.json());
    setShowFilesModal(true);
  };

  // ── Chat ────────────────────────────────────────────────────────────────────
  const handleSendMessage = async () => {
    if (!input.trim()) return;
    const userMsg: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    try {
      const response = await chatWithAssistant(input, messages);
      setMessages(prev => [...prev, { role: 'model', content: response }]);
    } catch (error: any) {
      setMessages(prev => [...prev, { role: 'model', content: `Error: ${error.message}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  const isIndexing = indexingProjectId !== null;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      <ToastContainer toasts={toasts} />

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-black/5 flex flex-col">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-8">
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
              <Briefcase className="text-white w-5 h-5" />
            </div>
            <h1 className="font-bold text-xl tracking-tight">WorkMind</h1>
          </div>
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'dashboard' ? 'bg-black text-white' : 'hover:bg-black/5 text-black/60'}`}
            >
              <LayoutDashboard size={18} />
              <span className="font-medium">Projects</span>
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all ${activeTab === 'chat' ? 'bg-black text-white' : 'hover:bg-black/5 text-black/60'}`}
            >
              <MessageSquare size={18} />
              <span className="font-medium">Assistant</span>
            </button>
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-black/5 space-y-2">
          {isIndexing && (
            <div className="text-xs text-emerald-600 font-medium flex items-center gap-2 px-1 mb-1">
              <Loader2 size={13} className="animate-spin" />
              {indexingLabel}
            </div>
          )}
          <label className="w-full flex items-center justify-center gap-2 bg-black text-white py-3 rounded-xl font-semibold transition-all shadow-sm hover:bg-black/80 cursor-pointer">
            <FolderOpen size={18} />
            Import Folder
            <input
              type="file"
              className="hidden"
              // @ts-ignore
              webkitdirectory=""
              directory=""
              onChange={handleImportFolder}
            />
          </label>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <header className="h-16 bg-white border-b border-black/5 flex items-center justify-between px-8">
          <h2 className="text-lg font-semibold capitalize">{activeTab}</h2>
          <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center">
            <Clock size={16} className="text-black/40" />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <AnimatePresence mode="wait">

            {/* Dashboard */}
            {activeTab === 'dashboard' && (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
              >
                {projects.map(project => (
                  <div key={project.id} className="bg-white p-6 rounded-2xl border border-black/5 shadow-sm hover:shadow-md transition-all group">
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-12 h-12 bg-black/5 rounded-xl flex items-center justify-center text-black/60 group-hover:bg-black group-hover:text-white transition-colors relative">
                        <FileText size={24} />
                        {/* File count badge */}
                        {fileCounts[project.id] !== undefined && (
                          <span className="absolute -top-1.5 -right-1.5 bg-black text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full group-hover:bg-white group-hover:text-black transition-colors">
                            {fileCounts[project.id]}
                          </span>
                        )}
                      </div>

                      <div className="flex gap-1 items-center">
                        <button onClick={() => handleViewFiles(project)} className="p-2 hover:bg-black/5 rounded-lg text-black/40 hover:text-black transition-colors" title="View indexed files">
                          <Search size={15} />
                        </button>
                        <button onClick={() => { setEditingProject(project); setEditProjectName(project.name); setShowEditProjectModal(true); }} className="p-2 hover:bg-black/5 rounded-lg text-black/40 hover:text-black transition-colors">
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => handleDeleteProject(project.id)} className="p-2 hover:bg-red-50 rounded-lg text-black/40 hover:text-red-500 transition-colors">
                          <Trash2 size={15} />
                        </button>

                        {/* Feed more data dropdown */}
                        <div className="relative ml-1">
                          <button
                            onClick={() => setActiveFeedMenu(activeFeedMenu === project.id ? null : project.id)}
                            className="bg-black text-white px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 hover:bg-black/80 transition-all"
                          >
                            <Plus size={13} />
                            Feed
                          </button>

                          <AnimatePresence>
                            {activeFeedMenu === project.id && (
                              <>
                                <div className="fixed inset-0 z-10" onClick={() => setActiveFeedMenu(null)} />
                                <motion.div
                                  initial={{ opacity: 0, y: 8, scale: 0.95 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  exit={{ opacity: 0, y: 8, scale: 0.95 }}
                                  className="absolute right-0 mt-2 w-44 bg-white border border-black/5 shadow-2xl rounded-2xl z-20 overflow-hidden"
                                >
                                  <label className="flex items-center gap-3 px-4 py-3 hover:bg-black/5 cursor-pointer transition-colors text-sm font-medium">
                                    <FileText size={15} className="text-black/40" />
                                    Add Files
                                    <input type="file" className="hidden" multiple onChange={(e) => handleAddFiles(project.id, e)} />
                                  </label>
                                  <label className="flex items-center gap-3 px-4 py-3 hover:bg-black/5 cursor-pointer transition-colors text-sm font-medium border-t border-black/5">
                                    <UploadCloud size={15} className="text-black/40" />
                                    Add Folder
                                    <input type="file" className="hidden"
                                      // @ts-ignore
                                      webkitdirectory="" directory=""
                                      onChange={(e) => handleAddFiles(project.id, e, true)} />
                                  </label>
                                </motion.div>
                              </>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    </div>

                    <h3 className="font-bold text-lg mb-1 truncate">{project.name}</h3>
                    <p className="text-black/40 text-sm mb-4">
                      {fileCounts[project.id] != null
                        ? `${fileCounts[project.id]} file${fileCounts[project.id] !== 1 ? 's' : ''} indexed`
                        : 'No files indexed yet'}
                    </p>
                    <div className="flex items-center gap-2 text-xs font-medium text-black/20">
                      <Clock size={12} />
                      Imported {new Date(project.created_at).toLocaleDateString()}
                    </div>
                  </div>
                ))}

                {/* Empty state */}
                {projects.length === 0 && (
                  <div className="col-span-full">
                    <label className="flex flex-col items-center justify-center py-24 rounded-3xl border-2 border-dashed border-black/10 hover:border-black/30 hover:bg-black/[0.02] transition-all cursor-pointer group">
                      <UploadCloud size={52} className="mb-4 text-black/20 group-hover:text-black/40 transition-colors" />
                      <p className="text-xl font-bold text-black/30 group-hover:text-black/50 transition-colors">Drop a folder to get started</p>
                      <p className="text-sm text-black/20 mt-1">Click to pick a folder — a project will be created automatically</p>
                      <input
                        type="file"
                        className="hidden"
                        // @ts-ignore
                        webkitdirectory=""
                        directory=""
                        onChange={handleImportFolder}
                      />
                    </label>
                  </div>
                )}
              </motion.div>
            )}

            {/* Chat */}
            {activeTab === 'chat' && (
              <motion.div
                key="chat"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex flex-col max-w-4xl mx-auto w-full"
              >
                <div className="flex-1 overflow-y-auto space-y-6 pb-4">
                  {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
                      <div className="w-16 h-16 bg-black/5 rounded-2xl flex items-center justify-center">
                        <MessageSquare size={32} className="text-black/20" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold">Your Work Assistant is ready</h3>
                        <p className="text-black/40 max-w-sm">Ask me anything about the folders you've imported.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3 mt-8">
                        {['What am I currently working on?', 'List my projects', 'What did I do in the last 3 months?', 'Search my code for...'].map(q => (
                          <button key={q} onClick={() => setInput(q)} className="px-4 py-2 bg-white border border-black/5 rounded-xl text-sm font-medium hover:bg-black hover:text-white transition-all shadow-sm">
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === 'user' ? 'bg-black text-white rounded-tr-none' : 'bg-white border border-black/5 shadow-sm rounded-tl-none'}`}>
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                  {isTyping && (
                    <div className="flex justify-start">
                      <div className="bg-white border border-black/5 p-4 rounded-2xl rounded-tl-none shadow-sm flex gap-1">
                        {[0, 150, 300].map(d => (
                          <span key={d} className="w-1.5 h-1.5 bg-black/20 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                        ))}
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                <div className="mt-4 relative">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Ask about your imported folders…"
                    className="w-full bg-white border border-black/10 rounded-2xl py-4 pl-6 pr-14 shadow-lg focus:outline-none focus:ring-2 focus:ring-black/5 transition-all"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={!input.trim() || isTyping}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center hover:scale-105 active:scale-95 transition-all disabled:opacity-20"
                  >
                    <Send size={18} />
                  </button>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </main>

      {/* Files Modal */}
      <AnimatePresence>
        {showFilesModal && viewingProject && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white w-full max-w-2xl rounded-3xl p-8 shadow-2xl flex flex-col max-h-[80vh]"
            >
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-2xl font-bold">Indexed Files</h3>
                  <p className="text-black/40 text-sm">{viewingProject.name} · {selectedProjectFiles.length} files</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-black/20" size={16} />
                    <input
                      type="text"
                      placeholder="Search files…"
                      value={fileSearchQuery}
                      onChange={(e) => setFileSearchQuery(e.target.value)}
                      className="pl-10 pr-4 py-2 bg-black/5 border-none rounded-xl text-sm focus:ring-2 focus:ring-black transition-all w-56"
                    />
                  </div>
                  <button onClick={() => setShowFilesModal(false)} className="p-2 hover:bg-black/5 rounded-full transition-all">
                    <Plus className="rotate-45" size={24} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                {selectedProjectFiles
                  .filter(f => f.name.toLowerCase().includes(fileSearchQuery.toLowerCase()) || f.path.toLowerCase().includes(fileSearchQuery.toLowerCase()))
                  .length === 0 ? (
                  <div className="text-center py-12 text-black/20">
                    <FileText size={48} className="mx-auto mb-2" />
                    <p>{fileSearchQuery ? 'No files match your search.' : 'No files indexed yet.'}</p>
                  </div>
                ) : (
                  selectedProjectFiles
                    .filter(f => f.name.toLowerCase().includes(fileSearchQuery.toLowerCase()) || f.path.toLowerCase().includes(fileSearchQuery.toLowerCase()))
                    .map(file => (
                      <div key={file.id} className="flex items-center justify-between p-3 bg-black/5 rounded-xl group hover:bg-black hover:text-white transition-all">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <FileText size={18} className="shrink-0 opacity-40 group-hover:opacity-100" />
                          <div className="truncate">
                            <p className="font-medium text-sm truncate">{file.name}</p>
                            <p className="text-[10px] opacity-40 group-hover:opacity-60 truncate">{file.path}</p>
                          </div>
                        </div>
                        <div className="text-[10px] opacity-40 group-hover:opacity-60 shrink-0 ml-4">
                          {new Date(file.last_modified).toLocaleDateString()}
                        </div>
                      </div>
                    ))
                )}
              </div>

              <div className="mt-6 pt-6 border-t border-black/5">
                <button onClick={() => setShowFilesModal(false)} className="w-full py-3 bg-black text-white rounded-xl font-semibold hover:bg-black/80 transition-all">
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit / Rename Modal */}
      <AnimatePresence>
        {showEditProjectModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl"
            >
              <h3 className="text-2xl font-bold mb-6">Rename Project</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-black/40 mb-2">Project Name</label>
                  <input
                    type="text"
                    value={editProjectName}
                    onChange={(e) => setEditProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUpdateProject()}
                    className="w-full bg-black/5 border-none rounded-xl py-3 px-4 focus:ring-2 focus:ring-black transition-all"
                    autoFocus
                  />
                </div>
                <div className="flex gap-3 pt-4">
                  <button onClick={() => setShowEditProjectModal(false)} className="flex-1 py-3 rounded-xl font-semibold text-black/40 hover:bg-black/5 transition-all">
                    Cancel
                  </button>
                  <button onClick={handleUpdateProject} disabled={!editProjectName.trim()} className="flex-1 bg-black text-white py-3 rounded-xl font-semibold hover:bg-black/80 transition-all disabled:opacity-20">
                    Save
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
