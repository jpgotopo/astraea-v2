import React, { useState, useEffect, useRef, useCallback } from 'react';
import TranscriptionWorker from './workers/transcriptionWorker?worker';
import { processAudioForModel, cleanIpaOutput, float32ToWav } from './utils/audioUtils';
import { saveData, getAllData, deleteData, getDataById } from './utils/db';

import { useTranslation } from 'react-i18next';

function App() {
  const { t, i18n } = useTranslation();

  const [activeTab, setActiveTab] = useState('project'); // 'project', 'sessions', 'people'
  const [isReady, setIsReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Initializing AI...');
  const [engineError, setEngineError] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Projects State
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);

  // People State
  const [people, setPeople] = useState([]);
  const [currentPerson, setCurrentPerson] = useState(null);

  // Sessions State
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);

  // AI/Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [translation, setTranslation] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editTranslation, setEditTranslation] = useState('');
  const [showMetadata, setShowMetadata] = useState(false);
  const [segments, setSegments] = useState([]); // [{id, audioBlob, transcript}]

  const worker = useRef(null);
  const mediaRecorder = useRef(null);
  const chunks = useRef([]);
  const recordingSessionId = useRef(null); // Link recording to a specific session ID
  const currentAudioBlob = useRef(null);
  const segmentsRef = useRef([]); // Ref to keep track of latest segments inside async worker callbacks
  const currentSessionRef = useRef(null); // Mirrors currentSession so the worker's onmessage (bound once) always reads the latest value

  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  // Persists whatever has been transcribed so far for the in-progress session.
  // Called after every segment (not just on final completion) so a crash,
  // reload, or low-memory tab kill doesn't wipe out a long recording's progress.
  const persistProgress = useCallback(async (targetId, partialTranscript) => {
    if (!targetId) return;
    const sessionToUpdate = await getDataById('sessions', targetId);
    if (!sessionToUpdate) return;
    const updated = {
      ...sessionToUpdate,
      transcript: partialTranscript,
      audio: currentAudioBlob.current,
      segments: segmentsRef.current
    };
    await saveData('sessions', updated);
    setSessions(prev => prev.map(s => s.id === targetId ? updated : s));
    if (currentSessionRef.current?.id === targetId) setCurrentSession(updated);
  }, []);

  // Creates (or recreates, after a failure) the transcription worker and wires
  // up its message handler. Only touches refs/setters/pure helpers — never
  // component state directly — so useCallback with no deps keeps it stable
  // across renders and safe to call again later from the "Retry" button.
  const startWorker = useCallback(() => {
    const w = new TranscriptionWorker();
    w.onmessage = async (event) => {
      const data = event.data;
      if (data.status === 'progress') setProgress(data.progress || 0);
      else if (data.status === 'ready') {
        setEngineError(null);
        setIsReady(true);
      }
      else if (data.status === 'error') {
        // The worker can fail while loading the model (network down, WebGPU/WASM
        // issues) or mid-transcription. Either way, surface it instead of leaving
        // the UI stuck on a spinner or a frozen progress bar with no explanation.
        console.error('TranscriptionWorker reported an error:', data.error);
        setEngineError(data.error || 'Unknown engine error');
        setIsProcessing(false);
        setStatus('Ready');
      }
      else if (data.status === 'segment_start') {
        setStatus(`Transcribing segment ${data.index + 1} of ${data.total}...`);
      }
      else if (data.status === 'segment_complete') {
        const audioBlob = float32ToWav(data.audioSegment);
        const newSegment = {
          id: Date.now() + Math.random(),
          audioBlob: audioBlob,
          transcript: data.text
        };
        segmentsRef.current = [...segmentsRef.current, newSegment];
        setSegments(segmentsRef.current);
        setTranscript(data.fullTranscript);
        await persistProgress(recordingSessionId.current, data.fullTranscript);
      }
      else if (data.status === 'complete') {
        setIsProcessing(false);
        setStatus('Ready');
        const result = cleanIpaOutput(data.output);
        setTranscript(result);

        // Save using the ID when recording STARTED
        const targetId = recordingSessionId.current;
        if (targetId) {
          await persistProgress(targetId, result);
          recordingSessionId.current = null;
        }
      }
    };
    w.postMessage({ cmd: 'load' });
    return w;
  }, [persistProgress]);

  // Terminates the current (possibly stuck or failed) worker and starts a
  // fresh one, resetting the loading UI. Exposed to the user via the error
  // banner's retry button.
  const handleRetryEngine = () => {
    worker.current?.terminate();
    setEngineError(null);
    setIsReady(false);
    setProgress(0);
    worker.current = startWorker();
  };

  useEffect(() => {
    const initData = async () => {
      const savedProjects = await getAllData('projects');
      const savedPeople = await getAllData('people');
      const savedSessions = await getAllData('sessions');

      setProjects(savedProjects);
      setPeople(savedPeople);
      setSessions(savedSessions);

      if (savedProjects.length > 0) setCurrentProject(savedProjects[0]);
    };
    initData();

    worker.current = startWorker();
    return () => worker.current.terminate();
  }, [startWorker]);

  // Project Functions
  const handleSaveProject = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const id = await saveData('projects', currentProject?.id ? { ...currentProject, ...data } : data);
    const updated = await getDataById('projects', id);
    setProjects(prev => currentProject?.id ? prev.map(p => p.id === id ? updated : p) : [...prev, updated]);
    setCurrentProject(updated);
  };

  const handleDeleteProject = async () => {
    if (!currentProject?.id) return;
    const linkedSessions = sessions.filter(s => s.projectId === currentProject.id);
    if (linkedSessions.length > 0) {
      alert(t('projects.cannotDeleteHasSessions', { count: linkedSessions.length }));
      return;
    }
    if (!window.confirm(t('projects.confirmDelete', { name: currentProject.name || t('projects.untitled') }))) return;
    await deleteData('projects', currentProject.id);
    setProjects(prev => prev.filter(p => p.id !== currentProject.id));
    setCurrentProject(null);
  };

  // Person Functions
  const handleSavePerson = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const id = await saveData('people', currentPerson?.id ? { ...currentPerson, ...data } : data);
    const updated = await getDataById('people', id);
    setPeople(prev => currentPerson?.id ? prev.map(p => p.id === id ? updated : p) : [...prev, updated]);
    setCurrentPerson(updated);
  };

  const handleDeletePerson = async () => {
    if (!currentPerson?.id) return;
    const linkedSessions = sessions.filter(s => String(s.personId) === String(currentPerson.id));
    if (linkedSessions.length > 0) {
      alert(t('people.cannotDeleteHasSessions', { count: linkedSessions.length }));
      return;
    }
    if (!window.confirm(t('people.confirmDelete', { name: currentPerson.fullName || t('people.untitled') }))) return;
    await deleteData('people', currentPerson.id);
    setPeople(prev => prev.filter(p => p.id !== currentPerson.id));
    setCurrentPerson(null);
  };

  // Session Functions
  const handleSaveSession = async (e) => {
    e.preventDefault();
    if (!currentProject) return alert(t('sessions.alertNoProject'));
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const sessionData = {
      ...data,
      projectId: currentProject.id,
      ...(currentSession?.id ? { id: currentSession.id, audio: currentSession.audio, transcript: currentSession.transcript, translation: currentSession.translation } : {})
    };
    const id = await saveData('sessions', sessionData);
    const updated = await getDataById('sessions', id);
    setSessions(prev => currentSession?.id ? prev.map(s => s.id === id ? updated : s) : [...prev, updated]);
    setCurrentSession(updated);
    setShowMetadata(false);
  };

  const handleDeleteSession = async () => {
    if (!currentSession?.id) return;
    if (!window.confirm(t('sessions.confirmDelete', { title: currentSession.title || t('sessions.untitled') }))) return;
    await deleteData('sessions', currentSession.id);
    setSessions(prev => prev.filter(s => s.id !== currentSession.id));
    setCurrentSession(null);
    setTranscript('');
    setTranslation('');
    setSegments([]);
    segmentsRef.current = [];
  };

  // Recording Logic
  const startRecording = async () => {
    if (!currentSession?.id) return alert(t('sessions.alertNoSession'));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder.current = new MediaRecorder(stream);
    chunks.current = [];
    setSegments([]); // Reset segments for new recording
    segmentsRef.current = [];
    recordingSessionId.current = currentSession.id;

    mediaRecorder.current.ondataavailable = (e) => chunks.current.push(e.data);
    mediaRecorder.current.onstop = async () => {
      const audioBlob = new Blob(chunks.current, { type: 'audio/wav' });
      currentAudioBlob.current = audioBlob;
      setIsProcessing(true);
      const audioBuffer = await processAudioForModel(audioBlob);
      // Transfer the underlying buffers instead of letting postMessage clone
      // them: audioBuffer is an array of Float32Array segments that can be
      // sizeable for long recordings, and it isn't read again after this call.
      const transferables = (Array.isArray(audioBuffer) ? audioBuffer : [audioBuffer]).map(seg => seg.buffer);
      worker.current.postMessage({ audio: audioBuffer }, transferables);
    };
    mediaRecorder.current.start();
    setIsRecording(true);
  };

  const stopRecording = () => {
    mediaRecorder.current?.stop();
    mediaRecorder.current?.stream.getTracks().forEach(t => t.stop());
    setIsRecording(false);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!currentProject?.id) { alert(t('sessions.alertNoProject')); return; }
    if (!currentSession?.id) { alert(t('sessions.alertNoSession')); return; }
    setSegments([]); // Reset segments for new upload
    segmentsRef.current = [];
    recordingSessionId.current = currentSession.id;
    currentAudioBlob.current = file;
    setIsProcessing(true);
    setStatus('Processing Uploaded File...');

    try {
      const audioBuffer = await processAudioForModel(file);
      const transferables = (Array.isArray(audioBuffer) ? audioBuffer : [audioBuffer]).map(seg => seg.buffer);
      worker.current.postMessage({ audio: audioBuffer }, transferables);
    } catch (error) {
      console.error("Error processing uploaded file:", error);
      alert(t('sessions.alertProcessError'));
      setIsProcessing(false);
      setStatus('Ready');
    }
  };

  const fileInputRef = useRef(null);

  const textAreaStyle = {
    width: '100%',
    background: 'var(--input-bg)',
    color: 'var(--text-main)',
    border: '1px solid var(--card-border)',
    borderRadius: '8px',
    padding: '0.75rem',
    fontSize: '1rem',
    fontFamily: 'Inter',
    resize: 'vertical',
    minHeight: '80px',
    boxSizing: 'border-box'
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
      <main style={{ width: '100%' }}>
        <header style={{ marginBottom: '3rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <div style={{ alignSelf: 'flex-end' }}>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <select
                value={i18n.language.substring(0, 2)}
                onChange={(e) => i18n.changeLanguage(e.target.value)}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '1rem', fontWeight: 'bold', outline: 'none' }}
              >
                <option value="en">EN</option>
                <option value="es">ES</option>
                <option value="id">ID</option>
              </select>
              <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '1rem' }}>
                {theme === 'light' ? t('app.themeLight') : t('app.themeDark')}
              </button>
            </div>
          </div>
          <h1 className="title-gradient" style={{ fontSize: '4rem', marginBottom: '0.5rem', marginTop: '0' }}>{t('app.title')}</h1>
          <p style={{ opacity: 0.6, color: 'var(--primary)', fontSize: '1.2rem', fontWeight: 600, margin: 0 }}>{t('app.subtitle')}</p>
        </header>

        <nav className="tabs-container">
          <button className={`tab-btn ${activeTab === 'project' ? 'active' : ''}`} onClick={() => setActiveTab('project')}>{t('tabs.projects')}</button>
          <button className={`tab-btn ${activeTab === 'people' ? 'active' : ''}`} onClick={() => setActiveTab('people')}>{t('tabs.people')}</button>
          <button className={`tab-btn ${activeTab === 'sessions' ? 'active' : ''}`} onClick={() => setActiveTab('sessions')}>{t('tabs.sessions')}</button>
        </nav>

        {engineError && (
          <div className="glass-card" style={{ textAlign: 'center', marginBottom: '3rem', padding: '2rem', border: '1px solid rgba(239, 68, 68, 0.4)' }}>
            <h2 style={{ marginTop: 0, color: '#ef4444' }}>{t('app.engineErrorTitle')}</h2>
            <p className="status-label" style={{ wordBreak: 'break-word' }}>{engineError}</p>
            <button type="button" className="btn-secondary danger" style={{ marginTop: '1rem' }} onClick={handleRetryEngine}>{t('app.retryBtn')}</button>
          </div>
        )}

        {!isReady && !engineError && (
          <div className="glass-card" style={{ textAlign: 'center', marginBottom: '3rem', padding: '3rem' }}>
            <h2 style={{ marginTop: 0 }}>{t('app.initializing')}</h2>
            <div className="progress-container"><div className="progress-bar" style={{ width: `${progress}%` }}></div></div>
            <p className="status-label">{t('app.downloading')} {progress.toFixed(1)}%</p>
          </div>
        )}

        {/* PROJECT TAB */}
        {activeTab === 'project' && (
          <div className="sidebar-layout">
            <aside>
              <button className="btn-secondary primary" style={{ width: '100%', marginBottom: '1.5rem' }} onClick={() => setCurrentProject({})}>{t('projects.new')}</button>
              <div className="list-pane">
                {projects.map(p => (
                  <div key={p.id} className={`list-item ${currentProject?.id === p.id ? 'selected' : ''}`} onClick={() => setCurrentProject(p)}>
                    <strong style={{ display: 'block', fontSize: '1.1rem' }}>{p.name || t('projects.untitled')}</strong>
                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{p.region || t('projects.noRegion')}</span>
                  </div>
                ))}
              </div>
            </aside>
            <section className="glass-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <h2 style={{ margin: 0 }}>{t('projects.metadata')}</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  {currentProject?.id && <span style={{ opacity: 0.4, fontSize: '0.8rem' }}>{t('projects.uuid')} {currentProject.id}</span>}
                  {currentProject?.id && <button type="button" className="btn-secondary danger" onClick={handleDeleteProject}>{t('projects.deleteBtn')}</button>}
                </div>
              </div>
              <form key={currentProject?.id || 'new-project'} onSubmit={async (e) => { await handleSaveProject(e); alert(t('projects.alertSave')); }} className="field-grid">
                <div className="field-group"><label>{t('projects.name')}</label><input name="name" defaultValue={currentProject?.name} required placeholder={t('projects.namePlaceholder')} /></div>
                <div className="field-group"><label>{t('projects.funding')}</label><input name="funding" defaultValue={currentProject?.funding} placeholder={t('projects.fundingPlaceholder')} /></div>
                <div className="field-group"><label>{t('projects.region')}</label><input name="region" defaultValue={currentProject?.region} placeholder={t('projects.regionPlaceholder')} /></div>
                <div className="field-group"><label>{t('projects.country')}</label><input name="country" defaultValue={currentProject?.country} placeholder={t('projects.countryPlaceholder')} /></div>
                <div className="field-group" style={{ gridColumn: 'span 2' }}><label>{t('projects.address')}</label><input name="address" defaultValue={currentProject?.address} placeholder={t('projects.addressPlaceholder')} /></div>
                <div className="field-group" style={{ gridColumn: 'span 2' }}><label>{t('projects.description')}</label><textarea name="description" defaultValue={currentProject?.description} placeholder={t('projects.descriptionPlaceholder')} /></div>
                <div className="field-group"><label>{t('projects.copyright')}</label><input name="copyright" defaultValue={currentProject?.copyright} placeholder={t('projects.copyrightPlaceholder')} /></div>
                <div className="field-group"><label>{t('projects.responsible')}</label><input name="responsible" defaultValue={currentProject?.responsible} placeholder={t('projects.responsiblePlaceholder')} /></div>
                <button type="submit" className="btn-secondary primary" style={{ gridColumn: 'span 2', marginTop: '1.5rem' }}>{t('projects.updateBtn')}</button>
              </form>
            </section>
          </div>
        )}

        {/* PEOPLE TAB */}
        {activeTab === 'people' && (
          <div className="sidebar-layout">
            <aside>
              <button className="btn-secondary primary" style={{ width: '100%', marginBottom: '1.5rem' }} onClick={() => setCurrentPerson({})}>{t('people.new')}</button>
              <div className="list-pane">
                {people.map(p => (
                  <div key={p.id} className={`list-item ${currentPerson?.id === p.id ? 'selected' : ''}`} onClick={() => setCurrentPerson(p)}>
                    <strong style={{ display: 'block', fontSize: '1.1rem' }}>{p.fullName || t('people.untitled')}</strong>
                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{p.nickname ? `"${p.nickname}"` : p.code || t('people.noCode')}</span>
                  </div>
                ))}
              </div>
            </aside>
            <section className="glass-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <h2 style={{ margin: 0 }}>{t('people.profile')}</h2>
                {currentPerson?.id && <button type="button" className="btn-secondary danger" onClick={handleDeletePerson}>{t('people.deleteBtn')}</button>}
              </div>
              <form key={currentPerson?.id || 'new-person'} onSubmit={async (e) => { await handleSavePerson(e); alert(t('people.alertSave')); }} className="field-grid">
                <div className="field-group"><label>{t('people.fullName')}</label><input name="fullName" defaultValue={currentPerson?.fullName} required placeholder={t('people.fullNamePlaceholder')} /></div>
                <div className="field-group"><label>{t('people.nickname')}</label><input name="nickname" defaultValue={currentPerson?.nickname} placeholder={t('people.nicknamePlaceholder')} /></div>
                <div className="field-group"><label>{t('people.code')}</label><input name="code" defaultValue={currentPerson?.code} placeholder={t('people.codePlaceholder')} /></div>
                <div className="field-group"><label>{t('people.birthYear')}</label><input type="number" name="birthYear" defaultValue={currentPerson?.birthYear} placeholder={t('people.birthYearPlaceholder')} /></div>
                <div className="field-group">
                  <label>{t('people.gender')}</label>
                  <select name="gender" defaultValue={currentPerson?.gender}>
                    <option value="">{t('people.select')}</option>
                    <option value="Male">{t('people.male')}</option><option value="Female">{t('people.female')}</option><option value="Other">{t('people.other')}</option>
                  </select>
                </div>
                <div className="field-group"><label>{t('people.primaryLang')}</label><input name="primaryLang" defaultValue={currentPerson?.primaryLang} placeholder={t('people.primaryLangPlaceholder')} /></div>
                <div className="field-group"><label>{t('people.learnedIn')}</label><input name="learnedIn" defaultValue={currentPerson?.learnedIn} placeholder={t('people.learnedInPlaceholder')} /></div>
                <div className="field-group"><label>{t('people.ethnic')}</label><input name="ethnic" defaultValue={currentPerson?.ethnic} placeholder={t('people.ethnicPlaceholder')} /></div>

                <div className="field-group" style={{ gridColumn: 'span 2' }}>
                  <label>{t('people.otherLangs')}</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem' }}>
                    <input name="other1" defaultValue={currentPerson?.other1} placeholder={t('people.lang2')} />
                    <input name="other2" defaultValue={currentPerson?.other2} placeholder={t('people.lang3')} />
                    <input name="other3" defaultValue={currentPerson?.other3} placeholder={t('people.lang4')} />
                    <input name="other4" defaultValue={currentPerson?.other4} placeholder={t('people.lang5')} />
                  </div>
                </div>

                <div className="field-group"><label>{t('people.education')}</label><input name="education" defaultValue={currentPerson?.education} placeholder={t('people.educationPlaceholder')} /></div>
                <div className="field-group"><label>{t('people.occupation')}</label><input name="occupation" defaultValue={currentPerson?.occupation} placeholder={t('people.occupationPlaceholder')} /></div>
                <div className="field-group" style={{ gridColumn: 'span 2' }}><label>{t('people.contact')}</label><input name="contact" defaultValue={currentPerson?.contact} placeholder={t('people.contactPlaceholder')} /></div>

                <button type="submit" className="btn-secondary primary" style={{ gridColumn: 'span 2', marginTop: '1.5rem' }}>{t('people.updateBtn')}</button>
              </form>
            </section>
          </div>
        )}

        {/* SESSIONS TAB */}
        {activeTab === 'sessions' && (
          <div className="sidebar-layout">
            <aside>
              <button className="btn-secondary primary" style={{ width: '100%', marginBottom: '1.5rem' }} onClick={() => {
                setCurrentSession({});
                setTranscript('');
                setTranslation('');
                setSegments([]);
                segmentsRef.current = [];
                setIsEditing(false);
              }}>{t('sessions.new')}</button>
              <div className="list-pane">
                {sessions.filter(s => s.projectId === currentProject?.id).map(s => (
                  <div key={s.id} className={`list-item ${currentSession?.id === s.id ? 'selected' : ''}`} onClick={() => {
                    setCurrentSession(s);
                    setTranscript(s.transcript || '');
                    setTranslation(s.translation || '');
                    setSegments(s.segments || []);
                    segmentsRef.current = s.segments || [];
                    setIsEditing(false);
                  }}>
                    <strong style={{ display: 'block', fontSize: '1.1rem' }}>{s.title || t('sessions.untitled')}</strong>
                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{s.date || t('sessions.noDate')}</span>
                  </div>
                ))}
              </div>
            </aside>
            <section className="main-pane">
              <div className="session-header">
                <div>
                  <h2 style={{ margin: 0 }}>{currentSession?.title || t('sessions.untitled')}</h2>
                  {currentProject && <span style={{ color: '#facc15', fontSize: '0.9rem' }}>{t('sessions.projectLabel', { name: currentProject.name })}</span>}
                </div>
                {currentSession?.id && (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="metadata-toggle" onClick={() => setShowMetadata(!showMetadata)}>
                      {showMetadata ? t('sessions.hideMetadata') : t('sessions.editMetadata')}
                    </button>
                    <button className="metadata-toggle danger" onClick={handleDeleteSession}>{t('sessions.deleteBtn')}</button>
                  </div>
                )}
              </div>

              {(!currentSession?.id || showMetadata) && (
                <div className="glass-card" style={{ padding: '2rem', marginBottom: '1rem' }}>
                  <form key={currentSession?.id || 'new-session'} onSubmit={async (e) => { await handleSaveSession(e); alert(t('sessions.alertSave')); }} className="field-grid">
                    <div className="field-group"><label>{t('sessions.sessionId')}</label><input name="sessionId" defaultValue={currentSession?.sessionId} placeholder={t('sessions.sessionIdPlaceholder')} /></div>
                    <div className="field-group"><label>{t('sessions.title')}</label><input name="title" defaultValue={currentSession?.title} required placeholder={t('sessions.titlePlaceholder')} /></div>
                    <div className="field-group"><label>{t('sessions.date')}</label><input type="date" name="date" defaultValue={currentSession?.date} /></div>
                    <div className="field-group"><label>{t('sessions.place')}</label><input name="place" defaultValue={currentSession?.place} placeholder={t('sessions.placePlaceholder')} /></div>

                    <div className="field-group">
                      <label>{t('sessions.speaker')}</label>
                      <select name="personId" defaultValue={currentSession?.personId} required>
                        <option value="">{t('sessions.selectPerson')}</option>
                        {people.map(p => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                      </select>
                    </div>

                    <div className="field-group">
                      <label>{t('sessions.genderVoice')}</label>
                      <select name="gender" defaultValue={currentSession?.gender}>
                        <option value="">{t('people.select')}</option>
                        <option value="Male">{t('people.male')}</option>
                        <option value="Female">{t('people.female')}</option>
                        <option value="Other">{t('sessions.otherNeutral')}</option>
                      </select>
                    </div>

                    <div className="field-group"><label>{t('sessions.consultant')}</label><input name="consultant" defaultValue={currentSession?.consultant} placeholder={t('sessions.consultantPlaceholder')} /></div>

                    <div className="field-group">
                      <label>{t('sessions.context')}</label>
                      <select name="context" defaultValue={currentSession?.context}>
                        <option value="">{t('sessions.selectContext')}</option>
                        <option value="Narration">{t('sessions.contextNarration')}</option>
                        <option value="Storytale">{t('sessions.contextStorytale')}</option>
                        <option value="Interview">{t('sessions.contextInterview')}</option>
                        <option value="Conversation">{t('sessions.contextConversation')}</option>
                        <option value="Word List">{t('sessions.contextWordList')}</option>
                        <option value="Other">{t('sessions.contextOther')}</option>
                      </select>
                    </div>

                    <div className="field-group" style={{ gridColumn: 'span 2' }}>
                      <label>{t('sessions.description')}</label>
                      <textarea name="description" defaultValue={currentSession?.description} placeholder={t('sessions.descriptionPlaceholder')} />
                    </div>

                    <button type="submit" className="btn-secondary primary" style={{ gridColumn: 'span 2' }}>
                      {currentSession?.id ? t('sessions.updateBtn') : t('sessions.createBtn')}
                    </button>
                  </form>
                </div>
              )}

              {currentSession?.id && (
                <div className="session-container">
                  {/* TOP: Recording Section */}
                  <div className="glass-card recording-panel" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: '1rem' }}>
                        <button
                          className={`record-btn ${isRecording ? 'recording' : ''}`}
                          onClick={isRecording ? stopRecording : startRecording}
                          disabled={!isReady || isProcessing}
                          title={isRecording ? t('sessions.stopRecording') : t('sessions.startRecording')}
                        >
                          {isProcessing ? <div className="spinner"></div> : (
                            <svg viewBox="0 0 24 24" width="36" height="36" fill="white">
                              {isRecording ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />}
                            </svg>
                          )}
                        </button>

                        {!isRecording && (
                          <>
                            <input
                              type="file"
                              ref={fileInputRef}
                              onChange={handleFileUpload}
                              accept="audio/*"
                              style={{ display: 'none' }}
                            />
                            <button
                              className="upload-btn"
                              onClick={() => fileInputRef.current?.click()}
                              disabled={!isReady || isProcessing}
                              title={t('sessions.uploadAudioFile')}
                            >
                              <svg className="upload-icon" viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
                                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: '200px' }}>
                        <div style={{ color: isRecording ? '#ef4444' : 'var(--primary)', fontWeight: 700, marginBottom: '0.5rem' }}>
                          {isRecording ? t('sessions.recordingState') : isProcessing ? status.toUpperCase() : t('sessions.readyState')}
                        </div>
                        {currentSession.audio && (
                          <audio controls src={URL.createObjectURL(currentSession.audio)} style={{ width: '100%', height: '40px' }} />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* BOTTOM: Transcription Section */}
                  <div className="glass-card transcription-panel" style={{ padding: '1.5rem', flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
                      <h3 style={{ margin: 0, color: '#facc15' }}>{t('sessions.transcriptionTitle')}</h3>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {!isEditing ? (
                          <button className="btn-secondary" onClick={() => {
                            setIsEditing(true);
                            setEditText(transcript);
                            setEditTranslation(translation);
                          }} disabled={!transcript && !translation && segments.length === 0}>{t('sessions.editBtn')}</button>
                        ) : (
                          <>
                            <button className="btn-secondary primary" onClick={async () => {
                              const updated = { ...currentSession, transcript: editText, translation: editTranslation };
                              await saveData('sessions', updated);
                              setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
                              setCurrentSession(updated);
                              setTranscript(editText);
                              setTranslation(editTranslation);
                              setIsEditing(false);
                            }}>{t('sessions.saveBtn')}</button>
                            <button className="btn-secondary" onClick={() => setIsEditing(false)}>{t('app.cancelBtn')}</button>
                          </>
                        )}
                        <button className="btn-secondary" onClick={() => {
                          const blob = new Blob([transcript], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `session_${currentSession.id}_transcript.txt`;
                          a.click();
                        }} disabled={!transcript}>{t('sessions.exportTransBtn')}</button>
                        <button className="btn-secondary" onClick={() => {
                          const blob = new Blob([translation], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `session_${currentSession.id}_translation.txt`;
                          a.click();
                        }} disabled={!translation}>{t('sessions.exportTranslBtn')}</button>
                      </div>
                    </div>

                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
                      {segments.length > 0 ? (
                        segments.map((seg, idx) => (
                          <div key={seg.id} className="item-card segment-grid" style={{ alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t('sessions.segmentHeader', { num: idx + 1 })}</span>
                              <audio controls src={URL.createObjectURL(seg.audioBlob)} style={{ width: '100%', height: '32px' }} />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)' }}>{t('sessions.transcriptionLabel')}</label>
                                <textarea
                                  placeholder={t('sessions.transcriptionPlaceholder')}
                                  value={seg.transcript || ''}
                                  onChange={async (e) => {
                                    const newSegments = [...segments];
                                    newSegments[idx].transcript = e.target.value;
                                    setSegments(newSegments);

                                    const newFull = newSegments.map(s => s.transcript).filter(Boolean).join(' ');
                                    setTranscript(newFull);

                                    if (currentSession?.id) {
                                      const updated = { ...currentSession, segments: newSegments, transcript: newFull };
                                      await saveData('sessions', updated);
                                      setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
                                    }
                                  }}
                                  style={textAreaStyle}
                                />
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--secondary)' }}>{t('sessions.translationLabel')}</label>
                                <textarea
                                  placeholder={t('sessions.translationPlaceholder')}
                                  value={seg.translation || ''}
                                  onChange={async (e) => {
                                    const newSegments = [...segments];
                                    newSegments[idx].translation = e.target.value;
                                    setSegments(newSegments);

                                    const newFullTrans = newSegments.map(s => s.translation).filter(Boolean).join(' ');
                                    setTranslation(newFullTrans);

                                    if (currentSession?.id) {
                                      const updated = { ...currentSession, segments: newSegments, translation: newFullTrans };
                                      await saveData('sessions', updated);
                                      setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
                                    }
                                  }}
                                  style={textAreaStyle}
                                />
                              </div>
                            </div>
                          </div>
                        ))
                      ) : isEditing ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1 }}>
                          <textarea value={editText} onChange={e => setEditText(e.target.value)} placeholder={t('sessions.editTranscrPlaceholder')} style={{ ...textAreaStyle, flex: 1 }} />
                          <textarea value={editTranslation} onChange={e => setEditTranslation(e.target.value)} placeholder={t('sessions.editTranslPlaceholder')} style={{ ...textAreaStyle, flex: 1 }} />
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1 }}>
                          <div className="ipa-box" style={{ flex: 1, padding: '1.5rem', fontSize: '1.2rem', textAlign: 'left', minHeight: '100px', display: 'block', wordWrap: 'break-word', whiteSpace: 'pre-wrap' }}>
                            <div style={{ fontSize: '0.8rem', opacity: 0.5, marginBottom: '0.5rem', textTransform: 'uppercase' }}>Transcription</div>
                            {transcript || '[ No transcript yet ]'}
                          </div>
                          <div className="ipa-box" style={{ flex: 1, padding: '1.5rem', fontSize: '1.2rem', textAlign: 'left', minHeight: '100px', display: 'block', color: 'var(--text-main)', wordWrap: 'break-word', whiteSpace: 'pre-wrap' }}>
                            <div style={{ fontSize: '0.8rem', opacity: 0.5, marginBottom: '0.5rem', textTransform: 'uppercase' }}>Translation</div>
                            {translation || '[ No translation yet ]'}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      <style>{`
        .spinner { width: 44px; height: 44px; border: 4px solid rgba(255, 255, 255, 0.2); border-radius: 50%; border-top-color: #facc15; animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

export default App;
