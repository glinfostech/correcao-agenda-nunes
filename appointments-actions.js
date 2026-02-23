// appointments-actions.js
import { db, state, BROKERS } from "./config.js";
import { checkOverlap, showDialog } from "./utils.js";
import { 
    doc, addDoc, updateDoc, collection, writeBatch
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { isAppointmentClosed, getLockMessage } from "./appointments-core.js";

// --- AÇÃO: SALVAR AGENDAMENTO ---
export async function saveAppointmentAction(formData) {
    const id = formData.id;
    const isNew = !id;
    const isAdmin = state.userProfile.role === "admin";

    let oldAppt = null;
    if (!isNew) {
        oldAppt = state.appointments.find(a => a.id === id);
        if (!oldAppt) throw new Error("Erro: Visita original não encontrada.");
    }


    if (!isNew && isAppointmentClosed(oldAppt.date, oldAppt.startTime)) {
        throw new Error(getLockMessage());
    }

    let finalOwnerEmail = isNew ? state.userProfile.email : oldAppt.createdBy;
    let finalOwnerName = isNew ? state.userProfile.name : oldAppt.createdByName;

    if (isAdmin && formData.adminSelectedOwner) {
        finalOwnerEmail = formData.adminSelectedOwner;
        const consultantObj = state.availableConsultants ? state.availableConsultants.find(c => c.email === finalOwnerEmail) : null;
        finalOwnerName = consultantObj ? consultantObj.name : (finalOwnerEmail === oldAppt?.createdBy ? oldAppt.createdByName : finalOwnerEmail);
    }

    const linkedConsultantEmail = String(formData.linkedConsultantEmail || finalOwnerEmail || "").trim();
    const linkedConsultantObj = state.availableConsultants ? state.availableConsultants.find(c => c.email === linkedConsultantEmail) : null;
    const linkedConsultantName = linkedConsultantObj ? linkedConsultantObj.name : (linkedConsultantEmail === finalOwnerEmail ? finalOwnerName : linkedConsultantEmail);

    // Objeto base para Salvar
    const nowIso = new Date().toISOString();

    const appointmentData = {
        brokerId: formData.brokerId,
        date: formData.date,
        startTime: formData.startTime,
        endTime: formData.endTime,
        isEvent: formData.isEvent,
        
        status: formData.status || "agendada",
        statusObservation: formData.statusObservation || "",
        isRented: formData.isRented || false, // NOVO CAMPO SALVO AQUI

        eventComment: formData.eventComment || "",
        properties: formData.properties || [],
        reference: formData.reference || "",
        propertyAddress: formData.propertyAddress || "",
        clients: formData.clients || [],
        sharedWith: formData.sharedWith || [],

        linkedConsultantEmail,
        linkedConsultantName,
        
        createdBy: finalOwnerEmail,
        createdByName: finalOwnerName,
        
        updatedAt: nowIso,
        updatedBy: state.userProfile.email,
        isEdited: !isNew,
        editedAt: !isNew ? nowIso : null
    };

    if (isNew) {
        appointmentData.createdAt = nowIso;
        appointmentData.isEdited = false;
        appointmentData.editedAt = null;
        if (!formData.isEvent) {
            const conflict = checkOverlap(appointmentData.brokerId, appointmentData.date, appointmentData.startTime, appointmentData.endTime, null, appointmentData.isEvent);
            if (conflict) throw new Error(conflict);
        }
    } else {
        if (!formData.isEvent) {
            const conflict = checkOverlap(appointmentData.brokerId, appointmentData.date, appointmentData.startTime, appointmentData.endTime, id, appointmentData.isEvent);
            if (conflict) throw new Error(conflict);
        }
    }

    // --- REGISTRO DE HISTÓRICO (Audit Log) ---
    if (!isNew) {
        const historyLog = oldAppt.history ? [...oldAppt.history] : [];
        const changes = detectChanges(oldAppt, appointmentData);
        
        if (changes.length > 0) {
            historyLog.push({
                date: new Date().toLocaleString("pt-BR"),
                user: state.userProfile.name,
                action: changes.join("; ")
            });
            appointmentData.history = historyLog;
        } else {
             appointmentData.history = historyLog;
        }
    } else {
        appointmentData.history = [{
            date: new Date().toLocaleString("pt-BR"),
            user: state.userProfile.name,
            action: "Criação do Agendamento"
        }];
    }

    // --- SALVAR NO FIRESTORE ---
    const isRecurrent = (isNew && isAdmin && formData.recurrence && formData.recurrence.days && formData.recurrence.days.length > 0 && formData.recurrence.endDate);

    try {
        if (isRecurrent) {
            const batch = writeBatch(db);
            const generatedDates = generateRecurrenceDates(formData.date, formData.recurrence.endDate, formData.recurrence.days);
            if (generatedDates.length === 0) throw new Error("Nenhuma data gerada para a recorrência selecionada.");

            generatedDates.forEach(dateStr => {
                const ref = doc(collection(db, "appointments"));
                const clone = { ...appointmentData, date: dateStr, isEdited: false, editedAt: null };
                batch.set(ref, clone);
            });
            await batch.commit();

            const firstRecurringAppt = { ...appointmentData, date: generatedDates[0], isEdited: false, editedAt: null };
            return {
                message: `${generatedDates.length} agendamentos criados com recorrência!`,
                actionType: "create",
                appointment: firstRecurringAppt
            };
        }

        if (isNew) {
            const createdRef = await addDoc(collection(db, "appointments"), appointmentData);
            return {
                message: "Agendamento salvo com sucesso!",
                actionType: "create",
                appointment: { id: createdRef.id, ...appointmentData }
            };
        }

        await updateDoc(doc(db, "appointments", id), appointmentData);
        return {
            message: "Agendamento salvo com sucesso!",
            actionType: "update",
            appointment: { id, ...appointmentData }
        };
    } catch (error) {
        console.error("Erro ao salvar:", error);
        throw new Error("Falha ao se comunicar com o banco de dados.");
    }
}

// --- AÇÃO: DELETAR AGENDAMENTO ---
export async function deleteAppointmentAction(appt) {
    try {
        if (isAppointmentClosed(appt?.date, appt?.startTime)) {
            throw new Error(getLockMessage());
        }

        await updateDoc(doc(db, "appointments", appt.id), {
            deletedAt: new Date().toISOString(),
            deletedBy: state.userProfile?.email || "unknown"
        });
        return true;
    } catch (err) {
        console.error("Erro ao deletar:", err);
        throw err;
    }
}

// --- FUNÇÕES DE APOIO ---
function detectChanges(oldAppt, newData) {
    const changes = [];
    const fields = {
        brokerId: "Corretor",
        date: "Data",
        startTime: "Início",
        endTime: "Fim",
        status: "Status",
        statusObservation: "Obs. Status",
        isRented: "Imóvel Alugado", 
        createdBy: "Responsável"
    };

    // --- FUNÇÃO AUXILIAR: PROCURA O NOME PELO EMAIL OU ID ---
    const getName = (idOrEmail) => {
        if (!idOrEmail) return null;
        
        // 1. Tenta encontrar na lista de Corretores
        let person = BROKERS.find(b => b.id === idOrEmail || b.email === idOrEmail);
        if (person && person.name) return person.name;
        
        // 2. Tenta encontrar na lista de Consultoras (guardada no state)
        if (state.availableConsultants) {
            person = state.availableConsultants.find(c => c.id === idOrEmail || c.email === idOrEmail);
            if (person && person.name) return person.name;
        }

        // 3. Tenta encontrar na lista geral de utilizadores (como prevenção)
        if (state.users) {
            person = state.users.find(u => u.id === idOrEmail || u.email === idOrEmail);
            if (person && person.name) return person.name;
        }

        // Se não encontrar em lado nenhum, mostra o e-mail que estava a ser enviado
        return idOrEmail; 
    };
    
    // --- Compara campos simples ---
    for (let key in fields) {
        let oldVal = oldAppt[key];
        let newVal = newData[key];
        
        if (key === "brokerId") {
            if (oldVal !== newVal) {
                const oldName = getName(oldVal) || "Nenhum";
                const newName = getName(newVal) || "Nenhum";
                changes.push(`Corretor: de '${oldName}' para '${newName}'`);
            }
        } else if (key === "createdBy") {
            if (oldVal !== newVal) {
                 const oldOwner = oldAppt.createdByName || getName(oldVal) || "Nenhum";
                 const newOwner = newData.createdByName || getName(newVal) || "Nenhum";
                 changes.push(`Responsável: de '${oldOwner}' para '${newOwner}'`);
            }
        } else if (key === "isRented") {
            const oldRented = oldVal ? "Sim" : "Não";
            const newRented = newVal ? "Sim" : "Não";
            if (oldRented !== newRented) {
                changes.push(`Imóvel Alugado: de '${oldRented}' para '${newRented}'`);
            }
        } else {
            let oldStr = String(oldVal || "").trim() || "Vazio";
            let newStr = String(newVal || "").trim() || "Vazio";
            if (oldStr !== newStr) {
                changes.push(`${fields[key]}: de '${oldStr}' para '${newStr}'`);
            }
        }
    }
    
    // --- Compara Imóveis detalhadamente ---
    const formatProps = (props) => {
        if (!props || props.length === 0) return "Nenhum";
        return props.map(p => {
            const ref = p.reference ? `Ref: ${p.reference}` : "";
            const end = p.propertyAddress ? `End: ${p.propertyAddress}` : "";
            const separator = (ref && end) ? " - " : "";
            return `[${ref}${separator}${end}]`;
        }).join(", ");
    };
    
    const oldPropsStr = formatProps(oldAppt.properties);
    const newPropsStr = formatProps(newData.properties);
    if (oldPropsStr !== newPropsStr) {
        changes.push(`Imóveis: de '${oldPropsStr}' para '${newPropsStr}'`);
    }

    // --- Compara Clientes detalhadamente ---
    const formatClients = (clients) => {
        if (!clients || clients.length === 0) return "Nenhum";
        return clients.map(c => c.name?.trim() || "Sem Nome").join(", ");
    };
    
    const oldClientsStr = formatClients(oldAppt.clients);
    const newClientsStr = formatClients(newData.clients);
    if (oldClientsStr !== newClientsStr) {
         changes.push(`Clientes: de '${oldClientsStr}' para '${newClientsStr}'`);
    }

    // --- Compara Partilha (sharedWith) COM NOMES ---
    const formatShared = (sharedList) => {
        if (!sharedList || sharedList.length === 0) return "Ninguém";
        // Transforma cada e-mail da lista no nome da pessoa
        return sharedList.map(email => getName(email)).join(", ");
    };
    
    const oldSharedStr = formatShared(oldAppt.sharedWith);
    const newSharedStr = formatShared(newData.sharedWith);
    if (oldSharedStr !== newSharedStr) {
        changes.push(`Partilhado com: de '${oldSharedStr}' para '${newSharedStr}'`);
    }

    return changes;
}
function generateRecurrenceDates(startDateStr, endDateStr, daysOfWeekArray) {
    const dates = [];
    let current = new Date(startDateStr + "T12:00:00"); 
    const end = new Date(endDateStr + "T12:00:00");
    
    while (current <= end) {
        if (daysOfWeekArray.includes(current.getDay())) {
            dates.push(current.toISOString().split("T")[0]);
        }
        current.setDate(current.getDate() + 1);
    }
    return dates;
}