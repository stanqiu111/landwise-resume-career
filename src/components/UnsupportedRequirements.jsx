export default function UnsupportedRequirements({ items }) {
  if (!items?.length) {
    return (
      <div className="unsupported-section all-supported">
        <h4 className="claims-title">✓ All Requirements Supported</h4>
        <p className="claims-subtitle">Every job requirement is backed by evidence in your resume!</p>
      </div>
    );
  }

  return (
    <div className="unsupported-section">
      <h4 className="claims-title">Skills Gap</h4>
      <p className="claims-subtitle">These JD requirements are not in your resume:</p>
      <ul className="gap-list">
        {items.map((item, idx) => (
          <li key={idx} className="gap-item">
            {item}
          </li>
        ))}
      </ul>
      <p className="gap-note">
        💡 Consider addressing these in your cover letter, learning plan, or future upskilling.
      </p>
    </div>
  );
}
