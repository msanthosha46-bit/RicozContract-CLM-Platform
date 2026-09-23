import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, BriefcaseBusiness, CheckCircle2, CircleDollarSign, CreditCard, Sparkles, ShieldCheck } from 'lucide-react';

const steps = [
  {
    icon: BriefcaseBusiness,
    title: 'Create smart contracts',
    text: 'Draft, assign, and issue contract workspaces with approvals built in from the beginning.',
  },
  {
    icon: ShieldCheck,
    title: 'Track obligations',
    text: 'Stay ahead of milestones, renewals, and obligations with live status updates and alerts.',
  },
  {
    icon: CircleDollarSign,
    title: 'Collect with clarity',
    text: 'Monitor invoice flow, payment timing, and cash movement from a single dashboard.',
  },
];

const featureCards = [
  {
    icon: CreditCard,
    title: 'Invoice automation',
    value: '2.4x faster',
    text: 'Automated reminders and payout tracking keep billing predictable.',
  },
  {
    icon: BarChart3,
    title: 'Cash flow visibility',
    value: 'Weekly snapshots',
    text: 'See revenue health and contract risk before it impacts your business.',
  },
  {
    icon: CheckCircle2,
    title: 'Approval confidence',
    value: '99.2% accuracy',
    text: 'Clear workflows mean team sign-offs move faster and with less friction.',
  },
];

const LandingPage = () => {
  return (
    <div className="min-h-screen bg-[#f4f6f9] text-[#111827]">
      <header className="sticky top-0 z-50 border-b border-[#e7ebf0] bg-[#ffffff]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#d51d29] text-lg font-black text-white shadow-lg shadow-red-200">
              RZ
            </div>
            <div className="text-xl font-black leading-none tracking-[-0.04em] text-[#111827] md:text-2xl">
              Ricoz<span className="text-[#1f2a44]">Contract</span>
            </div>
          </div>

          <nav className="hidden items-center gap-9 text-sm font-bold text-[#64748b] md:flex">
            <a href="#features" className="transition hover:text-[#0f172a]">Features</a>
            <a href="#journey" className="transition hover:text-[#0f172a]">How it works</a>
            <a href="#security" className="transition hover:text-[#0f172a]">Security</a>
          </nav>

          <div className="flex items-center gap-3">
            <Link
              to="/login"
              className="rounded-xl border border-[#d51d29] bg-white px-5 py-2.5 text-sm font-semibold text-[#d51d29] shadow-sm transition hover:bg-[#fff5f5]"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="rounded-xl bg-[#d51d29] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26]"
            >
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-20 pt-10 md:pt-14">
        <section className="text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#f5cacc] bg-[#fff5f5] px-4 py-1.5 text-xs font-bold text-[#d51d29] shadow-sm">
            <Sparkles className="h-3.5 w-3.5" />
            Finance, without the friction
          </div>

          <h1 className="mx-auto mt-6 max-w-6xl text-5xl font-black leading-[1.01] tracking-[-0.06em] text-[#0f172a] md:text-[76px]">
            RicozContract keeps
            <span className="mt-2 block">your business money in</span>
            <span className="mt-2 block">focus.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base font-normal leading-7 text-[#64748b] md:text-[18px]">
            Send invoices, track expenses, collect payments, and understand cash flow from one
            calm, connected workspace.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              to="/register"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#d51d29] px-6 py-3.5 text-sm font-bold text-white shadow-xl shadow-red-200 transition hover:bg-[#b91c26] md:px-7"
            >
              Create your workspace
              <ArrowRight className="h-5 w-5" />
            </Link>
            <Link
              to="/dashboard"
              className="inline-flex items-center justify-center rounded-xl border border-[#d9e1ea] bg-white px-6 py-3.5 text-sm font-bold text-[#0f172a] shadow-sm transition hover:border-[#ccd7e3] hover:bg-[#f8fafc] md:px-7"
            >
              Go to dashboard
            </Link>
          </div>

          <div className="relative mx-auto mt-16 max-w-5xl rounded-[26px] border border-[#e5e7eb] bg-white p-3 shadow-[0_22px_70px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between rounded-[18px] border border-[#edf1f5] bg-[#f8fafc] px-4 py-3 text-left">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full bg-[#ef4444]" />
                <span className="h-3 w-3 rounded-full bg-[#f59e0b]" />
                <span className="h-3 w-3 rounded-full bg-[#22c55e]" />
              </div>
              <div className="flex items-center gap-2 text-sm font-medium text-[#64748b]">
                <span className="h-2 w-2 rounded-full bg-[#0f172a]" />
                RicozContract / Dashboard
              </div>
            </div>

            <div className="mt-3 grid overflow-hidden rounded-[20px] border border-[#e2e8f0] bg-gradient-to-br from-[#0f172a] via-[#182a45] to-[#111827] p-4 md:grid-cols-[1.1fr_2fr]">
              <div className="flex flex-col justify-between rounded-[18px] bg-[#0f172a] p-5 text-white shadow-inner">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#d51d29] text-sm font-black text-white">
                      RZ
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-300">Workspace</div>
                      <div className="text-xl font-bold">RicozContract</div>
                    </div>
                  </div>
                  <div className="mt-6 rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
                    <div className="text-sm text-slate-300">Business overview</div>
                    <div className="mt-3 text-3xl font-black">$128.4K</div>
                    <div className="mt-2 flex items-center gap-2 text-sm text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" />
                      18.4% from last month
                    </div>
                  </div>
                </div>

                <div className="mt-6 space-y-3 text-sm text-slate-200">
                  <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
                    <span>Invoices issued</span>
                    <span className="font-semibold text-white">348</span>
                  </div>
                  <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
                    <span>Collected</span>
                    <span className="font-semibold text-emerald-300">96.8%</span>
                  </div>
                </div>
              </div>

              <div className="rounded-[18px] bg-[#f8fafc] p-5 md:p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-[#64748b]">Cash flow trend</div>
                    <div className="mt-1 text-2xl font-black text-[#0f172a]">$82,540</div>
                  </div>
                  <button className="rounded-xl bg-[#d51d29] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-red-100">
                    + Create
                  </button>
                </div>

                <div className="mt-8 grid gap-4 md:grid-cols-3">
                  {featureCards.map(({ icon: Icon, title, value, text }) => (
                    <div key={title} className="rounded-2xl border border-[#e2e8f0] bg-white p-4 text-left shadow-sm">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#fff0f0] text-[#d51d29]">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="mt-4 text-sm font-semibold text-[#0f172a]">{title}</div>
                      <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#64748b]">
                        {value}
                      </div>
                      <p className="mt-3 text-sm leading-6 text-[#475569]">{text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="journey" className="mt-20 rounded-[30px] border border-[#e5e7eb] bg-white p-6 shadow-[0_18px_45px_rgba(15,23,42,0.05)] md:p-8">
          <div className="flex flex-col items-center text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#d51d29]">Smooth customer journey</p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.05em] text-[#0f172a] md:text-5xl">
              From first quote to final payment.
            </h2>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {steps.map(({ icon: Icon, title, text }, index) => (
              <div key={title} className="relative rounded-[28px] border border-[#e5e7eb] bg-[#f8fafc] p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-xl">
                <div className="flex items-center justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#d51d29]">
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="text-sm font-semibold text-[#64748b]">0{index + 1}</span>
                </div>
                <h3 className="mt-5 text-xl font-bold text-[#0f172a]">{title}</h3>
                <p className="mt-3 text-base leading-7 text-[#475569]">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="mt-16 grid gap-5 md:grid-cols-3">
          {[
            'Built for legal, finance, and operations teams',
            'Real-time visibility on approvals, renewals, and revenue',
            'Secure, polished workflows designed for every customer touchpoint',
          ].map((item) => (
            <div key={item} className="rounded-[22px] border border-[#e5e7eb] bg-white p-5 text-base font-medium text-[#334155] shadow-sm">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#fff0f0] text-[#d51d29]">✓</span>
              <p className="mt-4 leading-7">{item}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
};

export default LandingPage;
