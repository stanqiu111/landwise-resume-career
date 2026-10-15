export default function ClaimCoverage({ coverage }) {
  const getColor = (pct) => {
    if (pct >= 85) return 'var(--success)';
    if (pct >= 60) return 'var(--warn)';
    return 'var(--error)';
  };

  const getLabel = (pct) => {
    if (pct >= 85) return 'Excellent';
    if (pct >= 60) return 'Good';
    if (pct >= 40) return 'Moderate';
    return 'Low';
  };

  return (
    <div className="claim-coverage">
      <h4 className="claims-title">Requirement Coverage</h4>
      <div className="coverage-card">
        <div className="coverage-score" style={{ color: getColor(coverage) }}>
          {coverage}%
        </div>
        <div className="coverage-bar">
          <div className="coverage-fill" style={{ width: `${coverage}%`, background: getColor(coverage) }} />
        </div>
        <p className="coverage-text">
          <span style={{ color: getColor(coverage), fontWeight: 600 }}>{getLabel(coverage)}</span>
          {' coverage of job requirements supported by your resume'}
        </p>
      </div>
    </div>
  );
}
