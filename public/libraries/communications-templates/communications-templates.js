/* Shared message-template token rendering for Calls, Settings, and future
 * Communications surfaces. Templates stay plain text and are resolved only
 * when selected, so the sender always reviews the final customer-facing copy.
 */
(function(){
  'use strict';

  const TOKEN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;
  const clean = (value) => String(value ?? '').trim();
  const VARIABLE_CATALOG = [
    { key:'first_name', label:(globalThis.PlatformLanguage?.text("communications-templates","m_ed956bd0cbfa79","First name") ?? "First name"), example:'Casey' },
    { key:'customer_name', label:(globalThis.PlatformLanguage?.text("communications-templates","m_753e7b59d4e9aa","Customer name") ?? "Customer name"), example:'Casey Customer' },
    { key:'company_name', label:(globalThis.PlatformLanguage?.text("communications-templates","m_e17c4838e115e8","Company name") ?? "Company name"), example:'FirstMate Roofing' },
    { key:'project_name', label:(globalThis.PlatformLanguage?.text("communications-templates","m_422f30a4a4cff1","Project name") ?? "Project name"), example:'Maple Street reroof' },
    { key:'phone', label:(globalThis.PlatformLanguage?.text("communications-templates","m_e0322091a7f398","Customer phone") ?? "Customer phone"), example:'(206) 555-1234' },
    { key:'sender_name', label:(globalThis.PlatformLanguage?.text("communications-templates","m_6a0f669097d3b9","Sender name") ?? "Sender name"), example:'Alex' },
    { key:'appointment_time', label:(globalThis.PlatformLanguage?.text("communications-templates","m_57d254a3d4839c","Appointment time") ?? "Appointment time"), example:'Tuesday at 9:00 AM' }
  ];

  function extractVariables(text){
    const found = new Set();
    String(text ?? '').replace(TOKEN, (_match, key) => {
      found.add(String(key).toLowerCase());
      return _match;
    });
    return [...found];
  }

  function render(text, values = {}, options = {}){
    const missing = [];
    const output = String(text ?? '').replace(TOKEN, (match, rawKey) => {
      const key = String(rawKey).toLowerCase();
      const value = values[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value);
      missing.push(key);
      return options.keepMissing === false ? '' : match;
    });
    return { text:output, missing:[...new Set(missing)], variables:extractVariables(text) };
  }

  function firstName(name){
    return clean(name).split(/\s+/)[0] || '';
  }

  function context(input = {}){
    const customerName = clean(input.customer_name || input.customerName || input.name);
    return {
      first_name:clean(input.first_name || input.firstName) || firstName(customerName),
      customer_name:customerName,
      company_name:clean(input.company_name || input.companyName),
      project_name:clean(input.project_name || input.projectName || input.project_title || input.projectTitle),
      phone:clean(input.phone),
      sender_name:clean(input.sender_name || input.senderName),
      appointment_time:clean(input.appointment_time || input.appointmentTime)
    };
  }

  window.FirstMateMessageTemplates = {
    variableCatalog:VARIABLE_CATALOG.map((item) => ({ ...item })),
    extractVariables,
    render,
    context
  };
})();
