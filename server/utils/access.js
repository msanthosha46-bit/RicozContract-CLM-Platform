const idOf = (ref) => {
  if (!ref) return null;
  if (typeof ref === 'object' && ref._id) return ref._id.toString();
  return ref.toString();
};

const canAccessContract = (user, contract) => {
  if (!user || !contract) return false;
  if (user.role !== 'Employee') return true;
  const uid = user._id.toString();
  return idOf(contract.createdBy) === uid || idOf(contract.assignedUser) === uid;
};

const employeeContractScope = (userId) => ({
  $or: [{ createdBy: userId }, { assignedUser: userId }]
});

module.exports = { idOf, canAccessContract, employeeContractScope };
