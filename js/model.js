// What a result's figures add up to. A port of the harness's result_state()
// (R/store.R), so the site and the terminal can never classify a result
// differently. Every flag states a fact; nothing here judges.

/** Input classes, as the harness splits them (input_class() in R/engine.R). */
export const CLASSES = {
  normal: {
    label: "normal", long: "Normal inputs",
    expect: "finite, not subnormal, inside the valid domain: a small relative error",
  },
  zero: {
    label: "±0", long: "±0",
    expect: "checked like any input; also among the exact points",
  },
  subnormal: {
    label: "subnormal", long: "Subnormal inputs",
    expect: "flushed to ±0 on entry by this backend: the result at ±0",
  },
  outside_domain: {
    label: "outside the domain", long: "Outside the valid domain",
    expect: "NaN by specification",
  },
  inf_nan: {
    label: "±∞ & NaN", long: "±∞ and NaN inputs",
    expect: "match base R exactly",
  },
};

/** No-finite-error region categories (the four the harness keeps visible, and
 * the fifth that validation adds). */
export const CATEGORIES = {
  failure: {
    label: "failure", cls: "warn",
    hint: "no finite error on valid inputs, and no tested cause accounts for it",
  },
  boundary: {
    label: "domain boundary", cls: "neutral",
    hint: "at an endpoint of the valid input domain, where base R gives a limiting value or convention",
  },
  backend_limitation: {
    label: "backend limitation", cls: "neutral",
    hint: "a subnormal input the backend flushed to a zero whose own result is right",
  },
  undefined_domain: {
    label: "undefined-domain convention", cls: "muted",
    hint: "a gradient where both forward values are NaN: no derivative exists, and the sides differ only in convention. Set aside, and shown",
  },
  reference_limitation: {
    label: "verified base R limitation", cls: "ok",
    hint: "base R is off, anvl is accurate, both against a stable reference that passed validation at high precision. Set aside, and shown",
  },
};

export const CAUSES = {
  nan_input: "the input is NaN",
  input_flushing: "subnormal input flushed to a zero whose result is right",
  flush_inherits_zero_error: "subnormal input flushed to a zero whose result is wrong",
  domain_boundary: "an endpoint of the valid domain",
  outside_domain: "outside the valid domain",
  zero_input: "the input is ±0",
  inf_input: "the input is ±∞",
  unidentified: "no tested cause",
};

/** Validation status of a reference, failing closed (reference_status()). */
export const REF_STATUS = {
  validated: { cls: "ok", label: "validated" },
  failed: { cls: "warn", label: "failed validation" },
  "not validated": { cls: "neutral", label: "not validated" },
  "no identity": { cls: "warn", label: "no identity: can never validate" },
};

const n0 = (v) => (typeof v === "number" && !Number.isNaN(v) ? v : 0);

export function state(r) {
  const n = (k) => n0(r[k]);
  const verified = r.ref_stable_status === "validated";
  const differ = n("n_samples") - n("n_exact");
  const refCand = verified ? n("n_ref_candidate") : 0;
  const refPts = verified ? n("n_points_ref_candidate") : 0;
  const worstAny = Math.max(n("worst_rel_err"), n("worst_point_rel_err"));
  return {
    verified,
    failing: n("n_runs_unclassified") > 0 || n("n_points_failure") > 0,
    boundary: n("n_regions_boundary") > 0 || n("n_points_boundary") > 0,
    backend: n("n_regions_backend") > 0 || n("n_points_backend") > 0,
    conventions: n("n_regions_domain") > 0 || n("n_points_domain") > 0,
    reference: verified && (n("n_ref_candidate") > 0 || n("n_points_ref_candidate") > 0),
    candidates: !verified && (n("n_ref_candidate") > 0 || n("n_points_ref_candidate") > 0),
    identical: r.n_samples != null && differ === 0 && n("n_zero_sign") === 0 &&
      n("n_points_identical") === n("n_points"),
    setAsideOnly: differ > 0 && n("n_zero_sign") === 0 &&
      differ === n("n_failing_domain") + refCand &&
      n("n_points_identical") + n("n_points_domain") + refPts === n("n_points"),
    worstAny,
    worstSetAside: verified
      ? Math.max(n("worst_rel_err_excl"), n("worst_point_rel_err_excl"))
      : worstAny,
  };
}

/**
 * The headline figure of a class: the worst relative error among samples
 * whose base R value is a normal float -- normal in, normal out, where a small
 * relative error is the right expectation. `setAside` is the same with
 * verified base R limitations left out, when there are any; it is never
 * reported in place of the other, only beside it.
 */
export function headline(c, verified) {
  if (!c) return null;
  const all = c.worst_out_normal ?? null;
  const excl = verified && typeof c.worst_out_normal_excl === "number" ? c.worst_out_normal_excl : null;
  return { all, setAside: excl !== null && excl !== all ? excl : null };
}
