/* Shared scope measurement selection. Read-only and DOM independent. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.FirstMateScopeData=api;})(typeof window==='undefined'?null:window,function(){
  function scope(project={},report={}){
    const hasMeasurements = (measurements) => Object.entries(measurements && typeof measurements === 'object' ? measurements : {})
      .some(([key, value]) => !['wastePercent', 'pitchRise', 'structures', 'structureCount'].includes(key) && typeof value !== 'object' && Number(value) > 0);
    const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const projectScopes = [project.scope, project.project_scope].map(asObject);
    const hasDefinition = (scope) => scope.pieces?.length || scope.root_items?.length;
    const projectScope = projectScopes.find(hasDefinition)
      || projectScopes.find((scope) => hasMeasurements(scope.measurements))
      || projectScopes.find((scope) => Object.keys(scope).length)
      || {};
    const proposals = Array.isArray(project.proposals) ? [...project.proposals].reverse() : [];

    // A signed proposal is frozen in a snapshot.  The project summary commonly
    // contains only delivery metadata for that proposal, while the measurements
    // remain nested in its content/scope.  Material generation already receives
    // this snapshot, so include the same sources when rendering the sidebar.
    const proposalMeasurementSources = (proposal) => {
      const item = asObject(proposal);
      const content = asObject(item.content);
      const editable = asObject(item.editable);
      const snapshot = asObject(item.snapshot);
      const snapshotContent = asObject(snapshot.content);
      return [
        item.measurements,
        asObject(item.scope).measurements,
        content.measurements,
        asObject(content.scope).measurements,
        editable.measurements,
        asObject(editable.scope).measurements,
        snapshotContent.measurements,
        asObject(snapshotContent.scope).measurements
      ].map(asObject);
    };
    const proposalScopes = (item) => [item.scope, item.content?.scope, item.editable?.scope, item.snapshot?.content?.scope].map(asObject);
    const proposal = proposals.find((item) => proposalScopes(item).some(hasDefinition))
      || proposals.find((item) => proposalMeasurementSources(item).some(hasMeasurements));
    const proposalMeasurements = proposal
      ? proposalMeasurementSources(proposal).reduce((merged, source) => ({ ...merged, ...source }), {})
      : {};
    const savedMeasurements = { ...asObject(project.measurements), ...proposalMeasurements, ...asObject(projectScope.measurements) };
    const measurements = hasMeasurements(savedMeasurements)
      ? { ...(hasMeasurements(report) ? report : {}), ...savedMeasurements }
      : { ...savedMeasurements, ...(hasMeasurements(report) ? report : {}) };
    const sourceScope = hasDefinition(projectScope) ? projectScope
      : (proposal ? proposalScopes(proposal).find(hasDefinition) : null) || projectScope;
    const pieces = Array.isArray(sourceScope.pieces) ? sourceScope.pieces.map((piece) => {
      const pieceMeasurements = piece?.measurements && typeof piece.measurements === 'object' ? piece.measurements : {};
      return hasMeasurements(pieceMeasurements) ? piece : { ...piece, measurements: { ...pieceMeasurements, ...measurements } };
    }) : [];
    return { ...sourceScope, measurements, pieces };
  }
  function measurements(project={},lists=[],report={}){
    const selected = scope(project,report);
    const hasMeasurements = (measurements) => Object.entries(measurements && typeof measurements === 'object' ? measurements : {})
      .some(([key, value]) => !['wastePercent', 'pitchRise', 'structures', 'structureCount'].includes(key) && typeof value !== 'object' && Number(value) > 0);
    if (selected.measurements && typeof selected.measurements === 'object' && hasMeasurements(selected.measurements)) return selected.measurements;
    const pieces = Array.isArray(selected.pieces) ? selected.pieces : [];
    const pieceMeasurements = pieces.reduce((merged, piece) => ({
      ...merged,
      ...(piece?.measurements && typeof piece.measurements === 'object' ? piece.measurements : {})
    }), {});
    if (hasMeasurements(pieceMeasurements)) return pieceMeasurements;

    // Generated lists retain the measurements from the signed proposal snapshot.
    // Use them only as a display fallback: an editable project scope with actual
    // values must always remain the source of truth for regeneration.
    const listMeasurements = lists.reduce((merged, list) => ({
      ...merged,
      ...(list?.measurements && typeof list.measurements === 'object' ? list.measurements : {})
    }), {});
    if (hasMeasurements(listMeasurements)) return listMeasurements;
    return selected.measurements && typeof selected.measurements === 'object' ? selected.measurements : pieceMeasurements;
  }
return {scope,measurements};
});
