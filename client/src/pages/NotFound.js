
import React from 'react';
import { Link } from 'react-router-dom';
import PageSEO from '../components/PageSEO';

const NotFound = () => {
  return (
    <>
      <PageSEO
        title="Page Not Found – RicozContract"
        description="The requested RicozContract page could not be found."
        robots="noindex, nofollow"
      />
      <main className="flex min-h-screen items-center justify-center bg-[#f3f5f8] px-6 py-12 text-slate-800 dark:bg-[#0b1220] dark:text-slate-100">
        <section className="w-full max-w-lg text-center">
          <p className="mb-3 text-sm font-bold uppercase tracking-[0.25em] text-blue-600 dark:text-blue-400">
            Error 404
          </p>

          <h1 className="mb-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
            Page not found
          </h1>

          <p className="mb-8 text-base leading-7 text-slate-600 dark:text-slate-400">
            Sorry, the page you're looking for doesn't exist or may have been moved.
            Please check the URL or return to RicozContract.
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            <Link
              to="/"
              className="rounded-lg bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Back to Homepage
            </Link>

            <Link
              to="/login"
              className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Login
            </Link>
          </div>
        </section>
      </main>
    </>
  );
};

export default NotFound;
