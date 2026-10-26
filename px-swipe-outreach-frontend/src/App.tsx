import { useMemo, useState } from 'react'
import {
  ArrowDownUp, ArrowLeft, ArrowRight, Bell, Bookmark, Check, ChevronDown,
  CircleHelp, Command, Filter, Heart, Inbox, LayoutDashboard, ListFilter,
  Mail, MoreHorizontal, Search, Settings, Sparkles, Target, ThumbsDown,
  Users, X,
} from 'lucide-react'

type Lead = {
  id: string; name: string; role: string; company: string; industry: string
  location: string; initials: string; color: string; bio: string
  reason: string; email: string; website: string; tags: string[]
}

const initialLeads: Lead[] = [
  { id: 'l1', name: 'Olivia Chen', role: 'VP of Growth', company: 'Northstar Labs', industry: 'SaaS', location: 'New York, NY', initials: 'OC', color: 'lavender', bio: 'Building repeatable growth engines for early-stage B2B teams. Previously helped scale two SaaS companies from seed to Series B.', reason: 'Recently posted about rebuilding their outbound motion — a strong fit for a personalized intro.', email: 'olivia@northstarlabs.example', website: 'northstarlabs.example', tags: ['Growth', 'B2B SaaS', 'Hiring'] },
  { id: 'l2', name: 'Marcus Reed', role: 'Founder & CEO', company: 'Fieldwork', industry: 'Technology', location: 'Brooklyn, NY', initials: 'MR', color: 'peach', bio: 'Founder focused on helping distributed teams turn customer conversations into better products.', reason: 'Company is expanding its sales team and exploring new ways to reach its ideal customers.', email: 'marcus@fieldwork.example', website: 'fieldwork.example', tags: ['Founder', 'Product-led', 'Seed stage'] },
  { id: 'l3', name: 'Priya Nair', role: 'Head of Partnerships', company: 'Mosaic Health', industry: 'Health tech', location: 'Boston, MA', initials: 'PN', color: 'mint', bio: 'Partnerships leader connecting thoughtful products with the people who need them most.', reason: 'Her partnerships remit overlaps with your target audience and recent company announcements.', email: 'priya@mosaichealth.example', website: 'mosaichealth.example', tags: ['Partnerships', 'Scale-up', 'Strategy'] },
  { id: 'l4', name: 'Ethan Brooks', role: 'Director of Sales', company: 'Brightpath', industry: 'Education', location: 'Remote · US', initials: 'EB', color: 'blue', bio: 'Sales leader who likes practical systems, thoughtful outreach, and coaching high-performing teams.', reason: 'A recent team expansion suggests a timely opportunity to start a conversation.', email: 'ethan@brightpath.example', website: 'brightpath.example', tags: ['Sales', 'Team building', 'EdTech'] },
]

const navItems = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Swipe leads', icon: Target },
  { label: 'Saved leads', icon: Bookmark },
  { label: 'Outreach', icon: Mail },
]

export default function App() {
  const [leads, setLeads] = useState(initialLeads)
  const [index, setIndex] = useState(0)
  const [saved, setSaved] = useState<string[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [activeNav, setActiveNav] = useState('Swipe leads')
  const [showFilters, setShowFilters] = useState(false)
  const [industry, setIndustry] = useState('All industries')
  const [toast, setToast] = useState('')
  const [showDetails, setShowDetails] = useState(false)

  const visibleLeads = useMemo(() => leads.filter((lead) => {
    const matchesQuery = `${lead.name} ${lead.company} ${lead.role} ${lead.location}`.toLowerCase().includes(query.toLowerCase())
    const matchesIndustry = industry === 'All industries' || lead.industry === industry
    return matchesQuery && matchesIndustry
  }), [leads, query, industry])
  const active = visibleLeads[index]

  function decide(decision: 'save' | 'skip') {
    if (!active) return
    const lead = active
    if (decision === 'save') {
      setSaved((old) => old.includes(lead.id) ? old : [...old, lead.id])
      setToast(`${lead.name} added to your saved leads`)
    } else {
      setSkipped((old) => old.includes(lead.id) ? old : [...old, lead.id])
      setToast(`${lead.name} skipped`)
    }
    setIndex((old) => Math.min(old + 1, visibleLeads.length))
    window.setTimeout(() => setToast(''), 2600)
  }

  function resetQueue() {
    setIndex(0)
    setToast('')
  }

  const savedLeads = leads.filter((lead) => saved.includes(lead.id))
  const completed = saved.length + skipped.length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(e) => { e.preventDefault(); setActiveNav('Swipe leads'); resetQueue() }}>
          <span className="brand-mark"><span /></span><span>px<span className="brand-dot">.</span></span>
        </a>
        <div className="workspace-switch">
          <div className="workspace-icon">P</div>
          <div className="workspace-copy"><strong>Personal workspace</strong><span>Free plan</span></div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${activeNav === label ? 'active' : ''}`} onClick={() => { setActiveNav(label); if (label === 'Swipe leads') resetQueue() }}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Saved leads' && saved.length > 0 && <span className="nav-count">{saved.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="upgrade-card"><div className="upgrade-icon"><Sparkles size={16} /></div><strong>Make every intro count</strong><p>Unlock more leads and smarter outreach insights.</p><button onClick={() => setToast('Plan upgrades are not connected in this demo.')}>Explore plans <ArrowRight size={14} /></button></div>
          <button className="nav-item muted"><CircleHelp size={17} /><span>Help & support</span></button>
          <button className="nav-item muted"><Settings size={17} /><span>Settings</span></button>
          <div className="profile"><div className="profile-avatar">JL</div><div className="profile-copy"><strong>Jim Lynch</strong><span>jim@example.com</span></div><MoreHorizontal size={18} /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{activeNav}</strong></div>
          <div className="top-actions">
            <div className="searchbox"><Search size={16} /><input value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0) }} placeholder="Search leads..." /><kbd><Command size={10} /> K</kbd></div>
            <button className="icon-button notification" aria-label="Notifications" onClick={() => setToast('You’re all caught up!')}><Bell size={18} /><i /></button>
            <div className="top-avatar">JL</div>
          </div>
        </header>

        <div className="content">
          {activeNav === 'Saved leads' ? (
            <section className="saved-page">
              <div className="eyebrow"><Bookmark size={14} /> YOUR SHORTLIST</div>
              <h1>Saved leads<span className="title-period">.</span></h1>
              <p className="page-subtitle">The people worth starting a conversation with.</p>
              {savedLeads.length ? <div className="saved-grid">{savedLeads.map((lead) => <LeadMiniCard key={lead.id} lead={lead} onRemove={() => setSaved(saved.filter((id) => id !== lead.id))} />)}</div> : <EmptyState title="Your shortlist starts here" message="Swipe right on a lead to save them for later." action={() => { setActiveNav('Swipe leads'); resetQueue() }} />}
            </section>
          ) : activeNav === 'Outreach' ? (
            <section className="saved-page">
              <div className="eyebrow"><Mail size={14} /> NEXT STEPS</div><h1>Ready to reach out<span className="title-period">.</span></h1>
              <p className="page-subtitle">Your saved leads are lined up for a thoughtful first message.</p>
              {savedLeads.length ? <div className="saved-grid">{savedLeads.map((lead) => <LeadMiniCard key={lead.id} lead={lead} onRemove={() => setSaved(saved.filter((id) => id !== lead.id))} showEmail />)}</div> : <EmptyState title="No one in your pipeline yet" message="Save a few promising leads and they’ll show up here." action={() => { setActiveNav('Swipe leads'); resetQueue() }} />}
            </section>
          ) : activeNav === 'Overview' ? (
            <section className="saved-page">
              <div className="eyebrow"><LayoutDashboard size={14} /> YOUR WORKSPACE</div><h1>A little progress goes a long way<span className="title-period">.</span></h1><p className="page-subtitle">A snapshot of your outreach activity.</p>
              <div className="stats-grid"><Stat label="Leads reviewed" value={String(completed).padStart(2, '0')} icon={<Users size={18} />} /><Stat label="Saved for outreach" value={String(saved.length).padStart(2, '0')} icon={<Bookmark size={18} />} /><Stat label="Skipped" value={String(skipped.length).padStart(2, '0')} icon={<ThumbsDown size={18} />} /></div>
              <div className="overview-cta"><div><span className="eyebrow">YOUR NEXT MOVE</span><h2>Find your next great connection.</h2><p>Review a few leads and build a shortlist that feels right.</p></div><button className="primary-button" onClick={() => { setActiveNav('Swipe leads'); resetQueue() }}>Start swiping <ArrowRight size={16} /></button></div>
            </section>
          ) : (
            <>
              <div className="page-heading">
                <div><div className="eyebrow"><Sparkles size={14} /> YOUR NEXT CONNECTION IS OUT THERE</div><h1>Swipe your way to <span>better outreach.</span></h1><p className="page-subtitle">A little curiosity can open a lot of doors. Find people worth knowing.</p></div>
                <button className="secondary-button" onClick={() => setShowFilters(!showFilters)}><Filter size={15} /> Filters <span className="filter-count">{industry !== 'All industries' ? '1' : '0'}</span></button>
              </div>

              {showFilters && <div className="filter-panel"><div><label htmlFor="industry">Industry</label><select id="industry" value={industry} onChange={(e) => { setIndustry(e.target.value); setIndex(0) }}><option>All industries</option>{Array.from(new Set(leads.map((l) => l.industry))).map((i) => <option key={i}>{i}</option>)}</select></div><button className="text-button" onClick={() => { setIndustry('All industries'); setQuery(''); setIndex(0) }}>Clear filters</button></div>}

              <div className="swipe-layout">
                <section className="discovery-column">
                  <div className="queue-heading"><div><span className="section-kicker">DISCOVER PEOPLE</span><h2>Your lead queue <span className="queue-pill">{visibleLeads.length}</span></h2></div><button className="plain-icon" aria-label="Sort queue" onClick={() => { setLeads([...leads].reverse()); setIndex(0) }}><ArrowDownUp size={16} /></button></div>
                  <div className="progress-row"><span>{Math.min(index, visibleLeads.length)} of {visibleLeads.length} reviewed</span><span>{visibleLeads.length ? Math.round(Math.min(index, visibleLeads.length) / visibleLeads.length * 100) : 0}%</span></div>
                  <div className="progress-track"><div style={{ width: `${visibleLeads.length ? Math.min(index, visibleLeads.length) / visibleLeads.length * 100 : 0}%` }} /></div>

                  {active ? <div className="lead-card">
                    <div className="card-topline"><span className="match-label"><Sparkles size={12} /> GOOD FIT FOR YOU</span><button className="plain-icon" aria-label="More lead actions" onClick={() => setShowDetails(!showDetails)}><MoreHorizontal size={19} /></button></div>
                    <div className="lead-identity">
                      <div className={`lead-avatar ${active.color}`}>{active.initials}<span className="online-dot" /></div>
                      <div className="lead-name-block"><h3>{active.name}</h3><p>{active.role}</p><div className="company-line"><span className="company-logo">{active.company.slice(0, 1)}</span><strong>{active.company}</strong><span className="verified">✓</span></div></div>
                    </div>
                    <div className="lead-meta"><span><Users size={14} /> {active.industry}</span><span><Target size={14} /> {active.location}</span></div>
                    <p className="lead-bio">{active.bio}</p>
                    <div className="fit-box"><div className="fit-heading"><span className="fit-spark"><Sparkles size={14} /></span><strong>Why this person?</strong></div><p>{active.reason}</p></div>
                    <div className="tag-row">{active.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
                    {showDetails && <div className="extra-details"><div><span>Email</span><strong>{active.email}</strong></div><div><span>Website</span><strong>{active.website}</strong></div></div>}
                    <div className="card-divider" />
                    <div className="swipe-hint"><span>Not a fit? Skip</span><span>Looks promising? Save</span></div>
                    <div className="decision-row"><button className="decision-button skip" onClick={() => decide('skip')} aria-label="Skip lead"><X size={21} /><span>Skip</span></button><button className="decision-button save" onClick={() => decide('save')}><Heart size={19} /><span>Save lead</span></button></div>
                  </div> : <div className="empty-queue"><div className="empty-illustration"><Check size={28} /></div><h3>You're all caught up.</h3><p>{visibleLeads.length === 0 ? 'No leads match those filters. Try widening your search.' : 'You’ve reviewed everyone in this queue. Come back for more connections soon.'}</p><button className="primary-button" onClick={resetQueue}>Review queue again <ArrowRight size={15} /></button></div>}

                  <div className="keyboard-note"><span><kbd>←</kbd> Skip</span><span><kbd>→</kbd> Save lead</span><span className="gesture-note">Or use the buttons above</span></div>
                </section>

                <aside className="right-rail">
                  <div className="rail-card momentum-card"><div className="rail-title"><div className="rail-icon purple"><Target size={17} /></div><span>YOUR MOMENTUM</span><MoreHorizontal size={18} /></div><div className="momentum-number">{completed}<span> / {leads.length}</span></div><p>Leads reviewed so far</p><div className="mini-progress"><div style={{ width: `${Math.min(100, completed / leads.length * 100)}%` }} /></div><div className="momentum-footer"><span><span className="legend-dot saved-dot" /> {saved.length} saved</span><span><span className="legend-dot skipped-dot" /> {skipped.length} skipped</span></div></div>
                  <div className="rail-card tip-card"><div className="tip-top"><div className="rail-icon yellow"><Sparkles size={17} /></div><span className="tip-label">A QUICK TIP</span></div><h3>Quality over quantity.</h3><p>The best outreach starts with a genuine reason to connect. Save people you’re actually curious about.</p><div className="tip-decoration"><Sparkles size={45} strokeWidth={0.8} /></div></div>
                  <div className="rail-card shortlist-card"><div className="rail-title"><div className="rail-icon green"><Bookmark size={16} /></div><span>YOUR SHORTLIST</span><button className="view-link" onClick={() => setActiveNav('Saved leads')}>View all <ArrowRight size={13} /></button></div>{savedLeads.length ? savedLeads.slice(0, 2).map((lead) => <div className="shortlist-person" key={lead.id}><div className={`small-avatar ${lead.color}`}>{lead.initials}</div><div><strong>{lead.name}</strong><span>{lead.company}</span></div><Check size={15} className="shortlist-check" /></div>) : <div className="shortlist-empty"><Inbox size={20} /><span>Your saved leads will show up here.</span></div>}</div>
                  <div className="privacy-note"><span className="privacy-dot" /> Demo mode <span>·</span> decisions stay in this browser session</div>
                </aside>
              </div>
            </>
          )}
          <footer className="footer"><span>© 2026 PX Outreach</span><span>Built for better conversations <Heart size={12} /></span><a href="https://github.com/JimLynchCodes/px-swipe-outreach" target="_blank" rel="noreferrer">Project repository <ArrowRight size={12} /></a></footer>
        </div>
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    </div>
  )
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return <div className="stat-card"><div className="stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong></div>
}
function LeadMiniCard({ lead, onRemove, showEmail = false }: { lead: Lead; onRemove: () => void; showEmail?: boolean }) {
  return <article className="mini-lead-card"><div className={`small-avatar large ${lead.color}`}>{lead.initials}</div><div className="mini-lead-copy"><strong>{lead.name}</strong><span>{lead.role} · {lead.company}</span>{showEmail && <span>{lead.email}</span>}<p>{lead.reason}</p></div><button className="plain-icon" onClick={onRemove} aria-label={`Remove ${lead.name}`}><X size={17} /></button></article>
}
function EmptyState({ title, message, action }: { title: string; message: string; action: () => void }) {
  return <div className="empty-queue page-empty"><div className="empty-illustration"><Bookmark size={25} /></div><h3>{title}</h3><p>{message}</p><button className="primary-button" onClick={action}>Discover leads <ArrowRight size={15} /></button></div>
}